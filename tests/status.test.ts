import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalRuns, renderRunDetail, renderRunsList } from "../src/status.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local run status", () => {
  it("lists runs from metadata and events newest first", () => {
    const runsDir = createRunsDir();
    writeRun(runsDir, "finished-run", {
      metadata: {
        status: "prepared",
        runId: "finished-run",
        repository: "fankaidev/grovie",
        issueNumber: 7,
        branchName: "grovie/issue-7",
        worktreePath: "/tmp/grovie/worktrees/finished-run",
      },
      events: [
        event("2026-05-23T09:00:00.000Z", "run.started"),
        event("2026-05-23T09:02:00.000Z", "run.succeeded", { runtime: "codex", exitCode: 0 }),
      ],
    });
    writeRun(runsDir, "active-run", {
      metadata: {
        runId: "active-run",
        repository: "fankaidev/grovie",
        issueNumber: 8,
        branchName: "grovie/issue-8",
      },
      events: [
        event("2026-05-23T10:00:00.000Z", "run.started"),
        event("2026-05-23T10:01:00.000Z", "runtime.started", { runtime: "codex" }),
      ],
    });

    const runs = listLocalRuns(runsDir, { now: new Date("2026-05-23T10:05:00.000Z") });

    expect(runs.map((run) => [run.runId, run.status])).toEqual([
      ["active-run", "active"],
      ["finished-run", "completed"],
    ]);
    expect(renderRunsList(runs)).toContain("Issue: fankaidev/grovie#8");
    expect(renderRunsList(runs)).toContain(`Logs: stdout=${join(runsDir, "active-run", "stdout.log")}`);
  });

  it("surfaces stale-looking active runs", () => {
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

  it("renders detailed paths and recent events for one run", () => {
    const runsDir = createRunsDir();
    writeRun(runsDir, "detail-run", {
      metadata: {
        runId: "detail-run",
        repository: "fankaidev/grovie",
        issueNumber: 10,
        branchName: "grovie/issue-10",
        localBranchName: "grovie/issue-10-attempt",
        worktreePath: "/tmp/grovie/worktrees/detail-run",
      },
      events: [
        event("2026-05-23T10:00:00.000Z", "run.started"),
        event("2026-05-23T10:01:00.000Z", "runtime.started", { runtime: "codex" }),
        event("2026-05-23T10:02:00.000Z", "runtime.finished", { exitCode: 1 }),
        event("2026-05-23T10:03:00.000Z", "run.failed", { exitCode: 1 }),
      ],
    });

    const [run] = listLocalRuns(runsDir, { now: new Date("2026-05-23T10:05:00.000Z") });

    expect(run).toBeDefined();
    expect(renderRunDetail(run!)).toContain("Run id: detail-run");
    expect(renderRunDetail(run!)).toContain("Status: failed");
    expect(renderRunDetail(run!)).toContain("Local branch: grovie/issue-10-attempt");
    expect(renderRunDetail(run!)).toContain(`Stdout log: ${join(runsDir, "detail-run", "stdout.log")}`);
    expect(renderRunDetail(run!)).toContain("2026-05-23T10:03:00.000Z run.failed");
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
