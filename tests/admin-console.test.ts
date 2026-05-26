import { createServer } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdminConsoleServer,
  resolveAdminConsoleConfig,
  startAdminConsoleServer,
  startAdminConsoleWorker,
  type StartedAdminConsole,
} from "../src/admin-console.js";
import { saveGlobalConfig } from "../src/config.js";
import { appendDaemonActivity } from "../src/daemon-activity.js";
import type { DaemonLifecycle } from "../src/daemon-lifecycle.js";
import type { LocalStatePaths } from "../src/local-state.js";
import type { AgentRuntime, RuntimeName } from "../src/runtime.js";
import type {
  AdminApiCancelRunResponse,
  AdminApiConfigResponse,
  AdminApiErrorResponse,
  AdminApiHealthResponse,
  AdminApiRepositoriesResponse,
  AdminApiRunDetailResponse,
  AdminApiRunEventsResponse,
  AdminApiRunLogResponse,
  AdminApiRunsResponse,
  AdminConsoleRootHealthResponse,
} from "../src/admin-api.js";

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
      agents: [],
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
    const payload = await response.json() as AdminConsoleRootHealthResponse;

    expect(payload).toEqual({
      ok: true,
      service: "grovie-admin-console",
    });
  });

  it("[UC-ADMIN-01-S05] resolves explicitly configured admin console bind hosts", () => {
    expect(resolveAdminConsoleConfig({
      version: 1,
      agents: [],
      watchedRepositories: [],
      adminConsole: {
        enabled: true,
        host: "0.0.0.0",
      },
    })).toEqual({
      enabled: true,
      host: "0.0.0.0",
      port: 8765,
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

  it("[UC-ADMIN-01-S07] serves health from a worker while the daemon thread is blocked", async () => {
    const root = createTmpDir();
    const port = await getAvailablePort();
    const started = await startAdminConsoleWorker({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      paths: pathsForRoot(root),
    });
    servers.push(started);

    const request = fetchFromWorker(`${started.url}/api/health`);
    blockCurrentThread(500);

    expect(await request).toMatchObject({
      status: 200,
      body: expect.objectContaining({
        ok: true,
        runtimes: expect.arrayContaining([expect.objectContaining({
          runtime: "codex",
        })]),
      }),
    });
  });

  it("[UC-ADMIN-02-S01] exposes daemon status and runtime availability through the health API", async () => {
    const started = await startTestServer();
    const response = await fetch(`${started.url}/api/health`);

    expect(response.status).toBe(200);
    const payload = await response.json() as AdminApiHealthResponse;

    expect(payload).toMatchObject({
      ok: true,
      daemon: {
        status: "stopped",
      },
      runtimes: expect.arrayContaining([expect.objectContaining({
        runtime: "codex",
        available: true,
      })]),
      agents: [],
    });
  });

  it("[UC-ADMIN-02-S01] exposes configured agent availability through the health API", async () => {
    const root = createTmpDir();
    saveGlobalConfig(root, {
      version: 1,
      agents: [
        { name: "codex", runtime: "codex", envKeys: [] },
        { name: "pi", runtime: "pi", envKeys: [] },
      ],
      watchedRepositories: [],
      adminConsole: { enabled: true },
    });
    const started = await startTestServer(root, {}, join(root, "missing-admin-web"), fakeRuntimeAvailability);

    const payload = await (await fetch(`${started.url}/api/health`)).json() as AdminApiHealthResponse;

    expect(payload.agents).toMatchObject([
      {
        agentId: expect.stringMatching(/^codex@/),
        runtime: "codex",
        availability: {
          available: true,
          message: "available (codex-cli 0.133.0)",
        },
      },
      {
        agentId: expect.stringMatching(/^pi@/),
        runtime: "pi",
        availability: {
          available: false,
          message: "pi command not found",
        },
      },
    ]);
  });

  it("[UC-ADMIN-02-S01] does not expose daemon verification tokens through the health API", async () => {
    const root = createTmpDir();
    const started = await startTestServer(root, {
      status: () => ({
        status: "running",
        state: {
          pid: 1234,
          command: ["node", "dist/cli.js", "daemon"],
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
      agents: [],
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
    const payload = JSON.parse(body) as AdminApiConfigResponse;

    expect(payload).toMatchObject({
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
      agents: [],
      watchedRepositories: [{ repository: "fankaidev/grovie", label: "ready" }],
      adminConsole: { enabled: true },
    });
    const started = await startTestServer(root);

    const payload = await (await fetch(`${started.url}/api/repos`)).json() as AdminApiRepositoriesResponse;

    expect(payload).toEqual({
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
    const payload = await response.json() as AdminApiRunsResponse;

    expect(payload).toMatchObject({
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

    const payload = await (await fetch(`${started.url}/api/runs/run-1`)).json() as AdminApiRunDetailResponse;

    expect(payload).toMatchObject({
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

    const payload = await (await fetch(`${started.url}/api/runs/run-1/events`)).json() as AdminApiRunEventsResponse;

    expect(payload).toEqual({
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

  it("[UC-ADMIN-02-S07] exposes recent daemon activity through the activity API", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    appendDaemonActivity(paths, {
      timestamp: "2026-05-23T10:00:00.000Z",
      type: "cycle.started",
      message: "Checking fankaidev/grovie for label grovie.",
      repository: "fankaidev/grovie",
    });
    appendDaemonActivity(paths, {
      timestamp: "2026-05-23T10:00:01.000Z",
      type: "run.started",
      message: "Starting fankaidev/grovie#124 for coco@kai-mini.",
      repository: "fankaidev/grovie",
      issueNumber: 124,
      agentId: "coco@kai-mini",
    });
    const started = await startTestServer(root);

    expect(await (await fetch(`${started.url}/api/activity`)).json()).toEqual({
      activity: [
        {
          timestamp: "2026-05-23T10:00:01.000Z",
          type: "run.started",
          message: "Starting fankaidev/grovie#124 for coco@kai-mini.",
          repository: "fankaidev/grovie",
          issueNumber: 124,
          agentId: "coco@kai-mini",
        },
        {
          timestamp: "2026-05-23T10:00:00.000Z",
          type: "cycle.started",
          message: "Checking fankaidev/grovie for label grovie.",
          repository: "fankaidev/grovie",
        },
      ],
    });
  });

  it("[UC-ADMIN-03-S01] serves a local admin home view with daemon, runtime, agents, repositories, and recent runs", async () => {
    const root = createTmpDir();
    saveGlobalConfig(root, {
      version: 1,
      agents: [
        { name: "codex", runtime: "codex", envKeys: [] },
        { name: "pi", runtime: "pi", envKeys: [] },
      ],
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
    const started = await startTestServer(root, {}, join(root, "missing-admin-web"), fakeRuntimeAvailability);
    const html = await (await fetch(`${started.url}/`)).text();

    expect(html).toContain("Grovie Admin Console");
    expect(html).toContain("Machine id:");
    expect(html).toContain(root);
    expect(html).toContain("Daemon");
    expect(html).toContain("codex");
    expect(html).toContain("codex@");
    expect(html).toContain("pi command not found");
    expect(html).toContain("fankaidev/grovie label=ready");
    expect(html).toContain("run-1");
    expect(html).toContain("/runs/run-1");
  });

  it("[UC-ADMIN-03-S04] shows recent daemon activity on the local admin home view", async () => {
    const root = createTmpDir();
    appendDaemonActivity(pathsForRoot(root), {
      timestamp: "2026-05-23T10:00:01.000Z",
      type: "run.resume_detected",
      message: "Found resumable run run-1 for fankaidev/grovie#124.",
      repository: "fankaidev/grovie",
      issueNumber: 124,
      agentId: "coco@kai-mini",
    });
    const started = await startTestServer(root);
    const html = await (await fetch(`${started.url}/`)).text();

    expect(html).toContain("Recent Activity");
    expect(html).toContain("run.resume_detected");
    expect(html).toContain("fankaidev/grovie");
    expect(html).toContain("#124");
    expect(html).toContain("coco@kai-mini");
    expect(html).toContain("Found resumable run run-1");
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
        runRequest: {
          sourceRunId: "old-run",
          reason: "resume",
        },
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
    expect(html).toContain("Run reason: resume; source run old-run");
    expect(html).toContain("grovie/issue-73");
    expect(html).toContain("/tmp/grovie/worktrees/run-1");
    expect(html).toContain("prompt.md");
    expect(html).toContain("task.json");
    expect(html).toContain("stdout.log");
    expect(html).toContain("stderr.log");
    expect(html).toContain("Result summary:");
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

  it("[UC-ADMIN-03-S02] [UC-ADMIN-03-S03] [UC-ADMIN-03-S05] serves built admin web assets and React-owned run detail routes", async () => {
    const root = createTmpDir();
    const assetsDir = join(root, "admin-web");
    mkdirSync(join(assetsDir, "assets"), { recursive: true });
    writeFileSync(join(assetsDir, "index.html"), '<!doctype html><div id="root" data-app="grovie-admin-web"></div><script type="module" src="/assets/app-abc123.js"></script>', "utf8");
    writeFileSync(join(assetsDir, "assets", "app-abc123.js"), "console.log('admin web');\n", "utf8");
    const started = await startTestServer(root, {}, assetsDir);

    const home = await fetch(`${started.url}/`);
    const route = await fetch(`${started.url}/runs/run-1`);
    const missingRoute = await fetch(`${started.url}/runs/missing`);
    const asset = await fetch(`${started.url}/assets/app-abc123.js`);
    const api = await fetch(`${started.url}/api/health`);

    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("/assets/app-abc123.js");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('data-app="grovie-admin-web"');
    expect(missingRoute.status).toBe(200);
    expect(await missingRoute.text()).toContain('data-app="grovie-admin-web"');
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("admin web");
    expect(await api.json()).toMatchObject({
      ok: true,
      daemon: {
        status: "stopped",
      },
    });
  });

  it("[UC-ADMIN-04-S01] returns the local stdout log for a completed run", async () => {
    const root = createTmpDir();
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 72,
      },
      events: [event("2026-05-23T10:00:00.000Z", "run.succeeded")],
      stdout: "stdout line\n",
      stderr: "stderr line\n",
    });
    const started = await startTestServer(root);

    const payload = await (await fetch(`${started.url}/api/runs/run-1/logs/stdout`)).json() as AdminApiRunLogResponse;

    expect(payload).toMatchObject({
      runId: "run-1",
      stream: "stdout",
      content: "stdout line\n",
    });
  });

  it("[UC-ADMIN-04-S06] exposes a parsed readable stdout transcript through the run log API", async () => {
    const root = createTmpDir();
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 133,
      },
      events: [event("2026-05-24T14:00:00.000Z", "runtime.started", { runtime: "codex" })],
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I will inspect the run." } }),
        JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pnpm check", aggregated_output: "ok\n", exit_code: 0, status: "completed" } }),
      ].join("\n"),
    });
    const started = await startTestServer(root);
    const response = await fetch(`${started.url}/api/runs/run-1/logs/stdout/transcript`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "run-1",
      stream: "stdout",
      transcript: {
        runtime: "codex",
        recognized: true,
        entries: [
          { kind: "status", label: "Session started", detail: "codex-thread-1" },
          { kind: "turn", label: "Turn started" },
          { kind: "assistant_message", text: "I will inspect the run." },
          { kind: "command_execution", command: "pnpm check", status: "completed", exitCode: 0 },
          { kind: "command_output", text: "ok\n" },
          { kind: "exit_code", exitCode: 0, detail: "completed" },
        ],
      },
    });
  });

  it("[UC-ADMIN-04-S07] returns a clear transcript fallback for unrecognized stdout", async () => {
    const root = createTmpDir();
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 133,
      },
      events: [event("2026-05-24T14:00:00.000Z", "runtime.started", { runtime: "codex" })],
      stdout: "plain stdout\n",
    });
    const started = await startTestServer(root);
    const response = await fetch(`${started.url}/api/runs/run-1/logs/stdout/transcript`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      transcript: {
        runtime: "codex",
        recognized: false,
        message: "stdout is not recognized as Codex JSONL. Use Raw stdout to inspect the original output.",
        entries: [],
      },
    });
  });

  it("[UC-ADMIN-04-S02] returns the local stderr log separately from stdout", async () => {
    const root = createTmpDir();
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 72,
      },
      events: [event("2026-05-23T10:00:00.000Z", "run.failed")],
      stdout: "stdout line\n",
      stderr: "stderr line\n",
    });
    const started = await startTestServer(root);
    const payload = await (await fetch(`${started.url}/api/runs/run-1/logs/stderr`)).json() as AdminApiRunLogResponse;

    expect(payload.content).toBe("stderr line\n");
    expect(payload.content).not.toContain("stdout line");
  });

  it("[UC-ADMIN-04-S03] streams appended log output for the selected log stream", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 72,
      },
      events: [event("2026-05-23T10:00:00.000Z", "runtime.started")],
      stdout: "live stdout\n",
      stderr: "live stderr\n",
    });
    const started = await startTestServer(root);
    const controller = new AbortController();
    const response = await fetch(`${started.url}/api/runs/run-1/logs/stream?stream=stdout`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();

    if (reader === undefined) {
      throw new Error("SSE response body was not readable");
    }

    const firstChunk = await reader.read();
    appendFileSync(join(paths.runsDir, "run-1", "stdout.log"), "appended stdout\n", "utf8");
    const secondChunk = await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const body = [
      firstChunk.value === undefined ? "" : new TextDecoder().decode(firstChunk.value),
      secondChunk.value === undefined ? "" : new TextDecoder().decode(secondChunk.value),
    ].join("");

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: snapshot");
    expect(body).toContain("event: append");
    expect(body).toContain("live stdout");
    expect(body).toContain("appended stdout");
    expect(body).not.toContain("live stderr");
  });

  it("[UC-ADMIN-04-S04] keeps stdout and stderr previews distinguishable in the run detail view", async () => {
    const root = createTmpDir();
    writeRun(pathsForRoot(root).runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 72,
      },
      events: [event("2026-05-23T10:00:00.000Z", "runtime.started")],
      stdout: "\u001b[31mred stdout\u001b[0m\n",
      stderr: "plain stderr\n",
    });
    const started = await startTestServer(root);
    const html = await (await fetch(`${started.url}/runs/run-1`)).text();

    expect(html).toContain("<h3>stdout</h3>");
    expect(html).toContain("ansi-red");
    expect(html).toContain("red stdout");
    expect(html).toContain("<h3>stderr</h3>");
    expect(html).toContain("plain stderr");
  });

  it("[UC-ADMIN-04-S05] returns clear errors for missing runs and invalid log streams", async () => {
    const started = await startTestServer();

    expect((await fetch(`${started.url}/api/runs/missing/logs/stdout`)).status).toBe(404);
    const invalid = await fetch(`${started.url}/api/runs/missing/logs/stream?stream=combined`);

    expect(invalid.status).toBe(400);
    const payload = await invalid.json() as AdminApiErrorResponse;

    expect(payload).toMatchObject({
      error: "invalid_stream",
    });
  });

  it("[UC-ADMIN-05-S01] records a local cancellation request for an active run", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(paths.runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 75,
      },
      events: [event("2999-05-23T10:00:00.000Z", "runtime.started")],
    });
    const started = await startTestServer(root);
    const response = await fetch(`${started.url}/api/runs/run-1/cancel`, {
      method: "POST",
    });

    expect(response.status).toBe(202);
    const payload = await response.json() as AdminApiCancelRunResponse;

    expect(payload).toMatchObject({
      ok: true,
      cancellation: {
        runId: "run-1",
        reason: "Canceled from local admin console.",
      },
    });
    expect(JSON.parse(readFileSync(join(paths.runsDir, "run-1", "cancel.json"), "utf8"))).toMatchObject({
      runId: "run-1",
    });
    expect(readFileSync(join(paths.runsDir, "run-1", "events.jsonl"), "utf8")).toContain("run.cancel_requested");
  });

  it("[UC-ADMIN-05-S03] rejects missing or terminal run cancellation without destructive side effects", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(paths.runsDir, "run-1", {
      metadata: {
        runId: "run-1",
        repository: "fankaidev/grovie",
        issueNumber: 75,
      },
      events: [event("2026-05-23T10:00:00.000Z", "run.succeeded")],
    });
    const started = await startTestServer(root);

    expect((await fetch(`${started.url}/api/runs/missing/cancel`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${started.url}/api/runs/run-1/cancel`, { method: "POST" })).status).toBe(409);
    expect(() => readFileSync(join(paths.runsDir, "run-1", "cancel.json"), "utf8")).toThrow();
  });

  it("[UC-ADMIN-05-S04] shows a confirmation-gated cancel action for active runs only", async () => {
    const root = createTmpDir();
    const paths = pathsForRoot(root);
    writeRun(paths.runsDir, "active-run", {
      metadata: {
        runId: "active-run",
        repository: "fankaidev/grovie",
        issueNumber: 75,
      },
      events: [event("2999-05-23T10:00:00.000Z", "runtime.started")],
    });
    writeRun(paths.runsDir, "done-run", {
      metadata: {
        runId: "done-run",
        repository: "fankaidev/grovie",
        issueNumber: 75,
      },
      events: [event("2026-05-23T10:00:00.000Z", "run.succeeded")],
    });
    const started = await startTestServer(root);

    const activeHtml = await (await fetch(`${started.url}/runs/active-run`)).text();
    const doneHtml = await (await fetch(`${started.url}/runs/done-run`)).text();

    expect(activeHtml).toContain("Cancel run");
    expect(activeHtml).toContain("confirm('Cancel this local run?')");
    expect(doneHtml).not.toContain("Cancel run");
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

function blockCurrentThread(ms: number): void {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

function fetchFromWorker(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");

      fetch(workerData.url)
        .then(async (response) => {
          parentPort.postMessage({
            status: response.status,
            body: await response.json(),
          });
        })
        .catch((error) => {
          parentPort.postMessage({
            error: error instanceof Error ? error.message : String(error),
          });
        });
    `, {
      eval: true,
      workerData: { url },
    });

    worker.once("message", (message: unknown) => {
      worker.terminate().catch(() => {});

      if (isFetchWorkerError(message)) {
        reject(new Error(message.error));
        return;
      }

      resolve(message as { status: number; body: unknown });
    });
    worker.once("error", reject);
  });
}

function isFetchWorkerError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

async function startTestServer(
  root = createTmpDir(),
  daemonLifecycleOverrides: Partial<DaemonLifecycle> = {},
  adminWebAssetsDir = join(root, "missing-admin-web"),
  runtimeAvailabilityChecker: (runtime: RuntimeName) => ReturnType<AgentRuntime["checkAvailability"]> = fakeRuntimeAvailability,
): Promise<StartedAdminConsole> {
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
      runtimeAvailabilityChecker,
      adminWebAssetsDir,
    }),
  });
  servers.push(started);
  return started;
}

function fakeRuntimeAvailability(runtime: RuntimeName): ReturnType<AgentRuntime["checkAvailability"]> {
  if (runtime === "pi") {
    return {
      runtime,
      command: "pi",
      available: false,
      message: "pi command not found",
    };
  }

  if (runtime === "claude-code") {
    return {
      runtime,
      command: "claude",
      available: true,
      version: "2.1.142 (Claude Code)",
      message: "available (2.1.142 (Claude Code))",
    };
  }

  return fakeRuntime().checkAvailability();
}

function pathsForRoot(root: string): LocalStatePaths {
  return {
    root,
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir: join(root, "runs"),
    locksDir: join(root, "locks"),
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
    start: () => {
      throw new Error("runtime start was not expected");
    },
    resume: () => {
      throw new Error("runtime resume was not expected");
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
    stdout?: string;
    stderr?: string;
  },
): void {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), input.events.map((item) => JSON.stringify(item)).join("\n"), "utf8");
  writeFileSync(join(runDir, "stdout.log"), input.stdout ?? "", "utf8");
  writeFileSync(join(runDir, "stderr.log"), input.stderr ?? "", "utf8");
}

function event(timestamp: string, type: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp,
    type,
    data,
  };
}
