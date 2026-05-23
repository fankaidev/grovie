import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdminConsoleServer,
  resolveAdminConsoleConfig,
  startAdminConsoleServer,
  type StartedAdminConsole,
} from "../src/admin-console.js";
import { saveGlobalConfig } from "../src/config.js";
import type { DaemonLifecycle } from "../src/daemon-lifecycle.js";
import type { LocalStatePaths } from "../src/local-state.js";
import type { AgentRuntime } from "../src/runtime.js";

const servers: StartedAdminConsole[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => new Promise<void>((resolve) => {
    started.server.close(() => resolve());
  })));
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("admin console server", () => {
  it("[UC-ADMIN-01-S02] resolves the enabled local admin console default bind address and port", () => {
    expect(resolveAdminConsoleConfig({
      version: 1,
      watchedRepositories: [],
      adminConsole: {
        enabled: true,
      },
    })).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 8765,
    });
  });

  it("[UC-ADMIN-01-S03] starts on an explicitly configured local port", async () => {
    const port = await getAvailablePort();
    const started = await startAdminConsoleServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      server: createAdminConsoleServer(),
    });
    servers.push(started);

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "grovie-admin-console",
    });
  });

  it("[UC-ADMIN-01-S04] fails clearly when the configured port is unavailable", async () => {
    const port = await getAvailablePort();
    const occupied = await startAdminConsoleServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      server: createAdminConsoleServer(),
    });
    servers.push(occupied);

    await expect(startAdminConsoleServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      server: createServer(),
    })).rejects.toThrow(`Admin console port ${port} is unavailable on 127.0.0.1.`);
  });

  it("[UC-ADMIN-02-S01] exposes daemon status and runtime availability through the health API", async () => {
    const started = await startTestServer();
    const response = await fetch(`${started.url}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      daemon: {
        status: "stopped",
      },
      runtime: {
        runtime: "codex",
        available: true,
      },
    });
  });

  it("[UC-ADMIN-02-S01] does not expose daemon verification tokens through the health API", async () => {
    const root = createTmpDir();
    const started = await startTestServer(root, {
      status: () => ({
        status: "running",
        state: {
          pid: 1234,
          command: ["node", "dist/cli.js", "daemon", "run"],
          startedAt: "2026-05-23T00:00:00.000Z",
          stdoutPath: join(root, "daemon", "stdout.log"),
          stderrPath: join(root, "daemon", "stderr.log"),
          statePath: join(root, "daemon", "daemon.json"),
          token: "secret-daemon-token",
        },
      }),
    });
    const body = await (await fetch(`${started.url}/api/health`)).text();

    expect(body).toContain('"status":"running"');
    expect(body).not.toContain("secret-daemon-token");
    expect(body).not.toContain("token");
  });

  it("[UC-ADMIN-02-S02] exposes global config without environment values or secrets", async () => {
    const root = createTmpDir();
    saveGlobalConfig(root, {
      version: 1,
      watchedRepositories: [
        {
          repository: "fankaidev/grovie",
          label: "grovie",
        },
      ],
      adminConsole: {
        enabled: true,
      },
    });
    const started = await startTestServer(root);
    const response = await fetch(`${started.url}/api/config`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      config: {
        watchedRepositories: [
          {
            repository: "fankaidev/grovie",
            label: "grovie",
          },
        ],
      },
    });
    expect(body).not.toContain("OPENAI_API_KEY");
    expect(body).not.toContain("secret");
  });

  it("[UC-ADMIN-02-S03] exposes watched repositories through the repos API", async () => {
    const root = createTmpDir();
    saveGlobalConfig(root, {
      version: 1,
      watchedRepositories: [{ repository: "fankaidev/grovie", label: "ready" }],
      adminConsole: { enabled: true },
    });
    const started = await startTestServer(root);

    expect(await (await fetch(`${started.url}/api/repos`)).json()).toEqual({
      repositories: [{ repository: "fankaidev/grovie", label: "ready" }],
    });
  });

  it("[UC-ADMIN-02-S04] exposes recent local runs through the runs API", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(paths.runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 74,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-74",
      },
      events: [
        event("2026-05-23T10:00:00.000Z", "runtime.started", { runtime: "codex" }),
        event("2026-05-23T10:01:00.000Z", "comment.created", { url: "https://github.com/fankaidev/grovie/issues/74#issuecomment-1" }),
      ],
    });
    const started = await startTestServer(root);
    const response = await fetch(`${started.url}/api/runs`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [
        {
          runId: "run-1",
          repository: "fankaidev/grovie",
          issueNumber: 74,
          branchName: "grovie/issue-74",
          resultLinks: ["https://github.com/fankaidev/grovie/issues/74#issuecomment-1"],
        },
      ],
    });
  });

  it("[UC-ADMIN-02-S05] exposes one run detail and returns 404 for missing runs", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(paths.runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 74,
        worktreePath: "/tmp/grovie/worktrees/run-1",
      },
      events: [event("2026-05-23T10:00:00.000Z", "run.failed", { exitCode: 1 })],
    });
    const started = await startTestServer(root);

    expect(await (await fetch(`${started.url}/api/runs/run-1`)).json()).toMatchObject({
      run: {
        runId: "run-1",
        issueNumber: 74,
        status: "failed",
        worktreePath: "/tmp/grovie/worktrees/run-1",
      },
    });
    expect((await fetch(`${started.url}/api/runs/missing`)).status).toBe(404);
  });

  it("[UC-ADMIN-02-S06] exposes run events and returns 404 for missing runs", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(paths.runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 74,
      },
      events: [event("2026-05-23T10:00:00.000Z", "run.failed", { exitCode: 1 })],
    });
    const started = await startTestServer(root);

    expect(await (await fetch(`${started.url}/api/runs/run-1/events`)).json()).toEqual({
      runId: "run-1",
      events: [
        {
          timestamp: "2026-05-23T10:00:00.000Z",
          type: "run.failed",
          data: {
            exitCode: 1,
          },
        },
      ],
    });
    expect((await fetch(`${started.url}/api/runs/missing/events`)).status).toBe(404);
  });

  it("[UC-ADMIN-03-S01] serves a local admin home view with daemon, runtime, repositories, and recent runs", async () => {
    const root = createTmpDir();
    saveGlobalConfig(root, {
      version: 1,
      watchedRepositories: [{ repository: "fankaidev/grovie", label: "ready" }],
      adminConsole: { enabled: true },
    });
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 73,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-73",
      },
      events: [event("2026-05-23T10:00:00.000Z", "runtime.started", { runtime: "codex" })],
    });
    const started = await startTestServer(root);
    const html = await (await fetch(`${started.url}/`)).text();

    expect(html).toContain("Grovie Admin Console");
    expect(html).toContain("Daemon");
    expect(html).toContain("codex");
    expect(html).toContain("fankaidev/grovie label=ready");
    expect(html).toContain("run-1");
    expect(html).toContain("/runs/run-1");
  });

  it("[UC-ADMIN-03-S02] serves a local run detail view with paths, events, and result links", async () => {
    const root = createTmpDir();
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 73,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-73",
        worktreePath: "/tmp/grovie/worktrees/run-1",
      },
      events: [
        event("2026-05-23T10:00:00.000Z", "runtime.started", { runtime: "codex" }),
        event("2026-05-23T10:01:00.000Z", "comment.created", { url: "https://github.com/fankaidev/grovie/issues/73#issuecomment-1" }),
      ],
    });
    const started = await startTestServer(root);
    const html = await (await fetch(`${started.url}/runs/run-1`)).text();

    expect(html).toContain("fankaidev/grovie#73");
    expect(html).toContain("coder@fankai-mac");
    expect(html).toContain("grovie/issue-73");
    expect(html).toContain("/tmp/grovie/worktrees/run-1");
    expect(html).toContain("stdout.log");
    expect(html).toContain("stderr.log");
    expect(html).toContain("comment.created");
    expect(html).toContain("https://github.com/fankaidev/grovie/issues/73#issuecomment-1");
  });

  it("[UC-ADMIN-03-S03] serves a clear not-found page for missing local runs", async () => {
    const started = await startTestServer();
    const response = await fetch(`${started.url}/runs/missing`);
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(html).toContain("Not Found");
    expect(html).toContain("Run not found.");
  });
});

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function startTestServer(root = createTmpDir(), daemonLifecycleOverrides: Partial<DaemonLifecycle> = {}): Promise<StartedAdminConsole> {
  const port = await getAvailablePort();
  const started = await startAdminConsoleServer({
    config: {
      enabled: true,
      host: "127.0.0.1",
      port,
    },
    server: createAdminConsoleServer({
      paths: pathsForRoot(root),
      daemonLifecycle: fakeDaemonLifecycle(root, daemonLifecycleOverrides),
      runtime: fakeRuntime(),
    }),
  });
  servers.push(started);
  return started;
}

function pathsForRoot(root: string): LocalStatePaths {
  return {
    root,
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir: join(root, "runs"),
    agentsDir: join(root, "agents"),
    locksDir: join(root, "locks"),
    requestsDir: join(root, "requests"),
    sessionsDir: join(root, "sessions"),
  };
}

function fakeDaemonLifecycle(root: string, overrides: Partial<DaemonLifecycle> = {}): DaemonLifecycle {
  return {
    start: () => ({
      ok: false,
      message: "daemon start was not expected",
    }),
    stop: () => ({
      ok: false,
      message: "daemon stop was not expected",
    }),
    status: () => ({
      status: "stopped",
      daemonDir: join(root, "daemon"),
    }),
    ...overrides,
  };
}

function fakeRuntime(): AgentRuntime {
  return {
    name: "codex",
    checkAvailability: () => ({
      runtime: "codex",
      command: "codex",
      available: true,
      version: "codex-cli 0.133.0",
      message: "available (codex-cli 0.133.0)",
    }),
    run: () => {
      throw new Error("runtime run was not expected");
    },
  };
}

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-admin-console-"));
  tmpDirs.push(dir);
  return dir;
}

function writeRun(
  runsDir: string,
  runId: string,
  input: {
    metadata: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  },
): void {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), input.events.map((item) => JSON.stringify(item)).join("\n"), "utf8");
  writeFileSync(join(runDir, "stdout.log"), "", "utf8");
  writeFileSync(join(runDir, "stderr.log"), "", "utf8");
}

function event(timestamp: string, type: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp,
    type,
    data,
  };
}
