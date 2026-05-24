import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalRuns, renderLocalStatusOverview, renderRunDetail, renderRunsList } from "../src/status.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local run status", () => {
  it("[UC-EXECUTION-02-S07] lists runs with issue, agent, runtime, result links, times, and logs newest first", () => {
    const runsDir = createRunsDir();
    writeRun(runsDir, "finished-run", {
      metadata: {
        status: "prepared",
        runId: "finished-run",
        repository: "fankaidev/grovie",
        issueNumber: 7,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-7",
        worktreePath: "/tmp/grovie/worktrees/finished-run",
      },
      events: [
        event("2026-05-23T09:00:00.000Z", "run.started"),
        event("2026-05-23T09:01:00.000Z", "result.handled", { runtime: "codex", pullRequestUrl: "https://github.com/fankaidev/grovie/pull/20" }),
        event("2026-05-23T09:02:00.000Z", "run.succeeded", { exitCode: 0 }),
      ],
    });
    writeRun(runsDir, "active-run", {
      metadata: {
        runId: "active-run",
        repository: "fankaidev/grovie",
        issueNumber: 8,
        agentId: "reviewer@fankai-mac",
        branchName: "grovie/issue-8",
      },
      events: [
        event("2026-05-23T10:00:00.000Z", "run.started"),
        event("2026-05-23T10:01:00.000Z", "runtime.started", { runtime: "codex" }),
      ],
    });

    const runs = listLocalRuns(runsDir, { now: new Date("2026-05-23T10:05:00.000Z") });

    expect(runs.map((run) => [run.runId, run.status])).toEqual([
      ["active-run", "running"],
      ["finished-run", "succeeded"],
    ]);
    expect(renderRunsList(runs)).toContain("Issue: fankaidev/grovie#8");
    expect(renderRunsList(runs)).toContain("Agent: reviewer@fankai-mac");
    expect(renderRunsList(runs)).toContain("Runtime: codex");
    expect(renderRunsList(runs)).toContain("Started: 2026-05-23T10:00:00.000Z");
    expect(renderRunsList(runs)).toContain("Ended: 2026-05-23T09:02:00.000Z");
    expect(renderRunsList(runs)).toContain("Result links: https://github.com/fankaidev/grovie/pull/20");
    expect(renderRunsList(runs)).toContain(`Logs: stdout=${join(runsDir, "active-run", "stdout.log")}`);
  });

  it("[UC-WORKER-06-S08] surfaces stale-looking active runs as recent failures in local status", () => {
    const runsDir = createRunsDir();
    writeRun(runsDir, "stale-run", {
      metadata: {
        runId: "stale-run",
        repository: "fankaidev/grovie",
        issueNumber: 9,
        branchName: "grovie/issue-9",
      },
      events: [event("2026-05-23T09:00:00.000Z", "runtime.started", { runtime: "codex" })],
    });

    const [run] = listLocalRuns(runsDir, {
      now: new Date("2026-05-23T10:00:01.000Z"),
      staleAfterMs: 30 * 60 * 1000,
    });

    expect(run?.status).toBe("stale");
    expect(renderRunsList(run === undefined ? [] : [run])).toContain("Status: stale");
  });

  it("[UC-DAEMON-03-S01] reports interrupted runs as interrupted even when stop-time failure events follow", () => {
    const runsDir = createRunsDir();
    writeRun(runsDir, "interrupted-run", {
      metadata: {
        status: "interrupted",
        runId: "interrupted-run",
        repository: "fankaidev/grovie",
        issueNumber: 9,
        branchName: "grovie/issue-9",
      },
      events: [
        event("2026-05-23T09:00:00.000Z", "run.interrupted", { resumeEligible: true }),
        event("2026-05-23T09:00:01.000Z", "runtime.finished", { exitCode: 143 }),
        event("2026-05-23T09:00:02.000Z", "run.failed", { exitCode: 143 }),
      ],
    });

    const [run] = listLocalRuns(runsDir, {
      now: new Date("2026-05-23T10:00:01.000Z"),
    });

    expect(run?.status).toBe("interrupted");
  });

  it("[UC-EXECUTION-02-S08] renders detailed paths, GitHub result links, and recent events for one run", () => {
    const runsDir = createRunsDir();
    writeRun(runsDir, "detail-run", {
      metadata: {
        runId: "detail-run",
        repository: "fankaidev/grovie",
        issueNumber: 10,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-10",
        localBranchName: "grovie/issue-10-attempt",
        worktreePath: "/tmp/grovie/worktrees/detail-run",
      },
      events: [
        event("2026-05-23T10:00:00.000Z", "run.started"),
        event("2026-05-23T10:01:00.000Z", "runtime.started", { runtime: "codex" }),
        event("2026-05-23T10:02:00.000Z", "runtime.finished", { exitCode: 1 }),
        event("2026-05-23T10:02:30.000Z", "comment.created", { url: "https://github.com/fankaidev/grovie/issues/10#issuecomment-1" }),
        event("2026-05-23T10:03:00.000Z", "run.failed", { exitCode: 1 }),
      ],
    });

    const [run] = listLocalRuns(runsDir, { now: new Date("2026-05-23T10:05:00.000Z") });

    expect(run).toBeDefined();
    expect(renderRunDetail(run!)).toContain("Run id: detail-run");
    expect(renderRunDetail(run!)).toContain("Status: failed");
    expect(renderRunDetail(run!)).toContain("Agent: coder@fankai-mac");
    expect(renderRunDetail(run!)).toContain("Runtime: codex");
    expect(renderRunDetail(run!)).toContain("Local branch: grovie/issue-10-attempt");
    expect(renderRunDetail(run!)).toContain(`Stdout log: ${join(runsDir, "detail-run", "stdout.log")}`);
    expect(renderRunDetail(run!)).toContain("Result links: https://github.com/fankaidev/grovie/issues/10#issuecomment-1");
    expect(renderRunDetail(run!)).toContain("2026-05-23T10:03:00.000Z run.failed");
  });

  it("[UC-WORKER-06-S08] renders local status with daemon state, watched repositories, paths, active runs, and failures", () => {
    const root = mkTmpDir();
    const runsDir = join(root, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeRun(runsDir, "active-run", {
      metadata: {
        runId: "active-run",
        repository: "fankaidev/grovie",
        issueNumber: 11,
        branchName: "grovie/issue-11",
      },
      events: [event("2026-05-23T10:00:00.000Z", "runtime.started", { runtime: "codex" })],
    });
    writeRun(runsDir, "failed-run", {
      metadata: {
        runId: "failed-run",
        repository: "fankaidev/grovie",
        issueNumber: 12,
        branchName: "grovie/issue-12",
      },
      events: [event("2026-05-23T09:00:00.000Z", "run.failed", { exitCode: 1 })],
    });
    const runs = listLocalRuns(runsDir, { now: new Date("2026-05-23T10:05:00.000Z") });

    const output = renderLocalStatusOverview({
      runs,
      daemonStatus: {
        status: "running",
        state: {
          pid: 1234,
          command: ["node", "dist/cli.js", "daemon", "run"],
          startedAt: "2026-05-23T08:00:00.000Z",
          stdoutPath: join(root, "daemon", "stdout.log"),
          stderrPath: join(root, "daemon", "stderr.log"),
          statePath: join(root, "daemon", "daemon.json"),
          token: "token",
        },
      },
      adminConsole: {
        enabled: true,
        host: "127.0.0.1",
        port: 8765,
      },
      watchedRepositories: [{ repository: "fankaidev/grovie", label: "grovie" }],
      paths: {
        root,
        reposDir: join(root, "repos"),
        worktreesDir: join(root, "worktrees"),
        runsDir,
        agentsDir: join(root, "agents"),
        locksDir: join(root, "locks"),
        requestsDir: join(root, "requests"),
        sessionsDir: join(root, "sessions"),
      },
    });

    expect(output).toContain("Status: running");
    expect(output).toContain("Admin console:");
    expect(output).toContain("URL: http://127.0.0.1:8765");
    expect(output).toContain("Availability: expected available while the daemon is running");
    expect(output).toContain("- fankaidev/grovie label=grovie");
    expect(output).toContain(`Runs: ${runsDir}`);
    expect(output).toContain("active-run fankaidev/grovie#11 status=running");
    expect(output).toContain("failed-run fankaidev/grovie#12 status=failed");
  });
});

function createRunsDir(): string {
  const root = mkTmpDir();
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

function mkTmpDir(): string {
  const dir = join(tmpdir(), `grovie-status-test-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
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
