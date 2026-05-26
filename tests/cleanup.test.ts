import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupLocalState, parseOlderThan, renderCleanupResult } from "../src/cleanup.js";
import type { LocalStatePaths } from "../src/local-state.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local state cleanup", () => {
  it("[UC-SESSION-02-S08] renders a dry-run cleanup plan without deleting artifacts", () => {
    const paths = createPaths();
    const worktreePath = join(paths.worktreesDir, "session-1");
    writeRun(paths, "run-1", {
      status: "succeeded",
      worktreePath,
      events: [
        event("2026-05-23T10:00:00.000Z", "run.started"),
        event("2026-05-23T10:01:00.000Z", "run.succeeded"),
      ],
    });

    const result = cleanupLocalState({
      paths,
      dryRun: true,
      now: new Date("2026-05-23T11:00:00.000Z"),
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(paths.runsDir, "run-1"))).toBe(true);
    expect(renderCleanupResult(result)).toContain("Would remove worktrees: 1");
    expect(renderCleanupResult(result)).toContain(worktreePath);
  });

  it("[UC-SESSION-02-S07] removes succeeded session worktrees while preserving run history", () => {
    const paths = createPaths();
    const worktreePath = join(paths.worktreesDir, "session-1");
    writeRun(paths, "run-1", {
      status: "succeeded",
      worktreePath,
      events: [
        event("2026-05-23T10:00:00.000Z", "run.started"),
        event("2026-05-23T10:01:00.000Z", "run.succeeded"),
      ],
    });

    const result = cleanupLocalState({
      paths,
      now: new Date("2026-05-23T11:00:00.000Z"),
    });

    expect(result.removedWorktrees).toHaveLength(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(paths.runsDir, "run-1"))).toBe(true);
    expect(readFileSync(join(paths.runsDir, "run-1", "events.jsonl"), "utf8")).toContain('"type":"worktree.cleaned"');
  });

  it("[UC-SESSION-02-S09] skips failed, canceled, active, and stale session worktrees by default", () => {
    const paths = createPaths();
    const failedWorktree = join(paths.worktreesDir, "failed");
    const canceledWorktree = join(paths.worktreesDir, "canceled");
    const activeWorktree = join(paths.worktreesDir, "active");
    const staleWorktree = join(paths.worktreesDir, "stale");
    writeRun(paths, "failed-run", {
      status: "failed",
      worktreePath: failedWorktree,
      events: [event("2026-05-23T10:00:00.000Z", "run.failed")],
    });
    writeRun(paths, "canceled-run", {
      status: "canceled",
      worktreePath: canceledWorktree,
      events: [event("2026-05-23T10:00:00.000Z", "run.canceled")],
    });
    writeRun(paths, "active-run", {
      status: "prepared",
      worktreePath: activeWorktree,
      events: [event("2026-05-23T10:55:00.000Z", "runtime.started")],
    });
    writeRun(paths, "stale-run", {
      status: "prepared",
      worktreePath: staleWorktree,
      events: [event("2026-05-23T10:00:00.000Z", "runtime.started")],
    });

    const result = cleanupLocalState({
      paths,
      now: new Date("2026-05-23T11:00:00.000Z"),
    });

    expect(result.removedWorktrees).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(existsSync(failedWorktree)).toBe(true);
    expect(existsSync(canceledWorktree)).toBe(true);
    expect(existsSync(activeWorktree)).toBe(true);
    expect(existsSync(staleWorktree)).toBe(true);
  });

  it("[UC-SESSION-02-S09] refuses to remove metadata worktree paths outside Grovie worktrees", () => {
    const paths = createPaths();
    const outsideDir = mkdtempSync(join(tmpdir(), "grovie-outside-"));
    tmpDirs.push(outsideDir);
    writeRun(paths, "outside-run", {
      status: "succeeded",
      worktreePath: outsideDir,
      events: [event("2026-05-23T10:00:00.000Z", "run.succeeded")],
    });

    const result = cleanupLocalState({
      paths,
      now: new Date("2026-05-23T11:00:00.000Z"),
    });

    expect(result.removedWorktrees).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        path: outsideDir,
        reason: "worktree is outside Grovie worktrees directory",
      }),
    ]);
    expect(existsSync(outsideDir)).toBe(true);
  });

  it("[UC-SESSION-02-S10] removes terminal run directories only when logs are explicitly included", () => {
    const paths = createPaths();
    writeRun(paths, "succeeded-run", {
      status: "succeeded",
      worktreePath: join(paths.worktreesDir, "succeeded"),
      events: [event("2026-05-23T10:00:00.000Z", "run.succeeded")],
    });
    writeRun(paths, "failed-run", {
      status: "failed",
      worktreePath: join(paths.worktreesDir, "failed"),
      events: [event("2026-05-23T10:00:00.000Z", "run.failed")],
    });
    writeRun(paths, "active-run", {
      status: "prepared",
      worktreePath: join(paths.worktreesDir, "active"),
      events: [event("2026-05-23T10:00:00.000Z", "runtime.started")],
    });

    const result = cleanupLocalState({
      paths,
      includeLogs: true,
      now: new Date("2026-05-23T10:05:00.000Z"),
    });

    expect(result.removedRunDirs.map((action) => action.runId).sort()).toEqual(["failed-run", "succeeded-run"]);
    expect(existsSync(join(paths.runsDir, "succeeded-run"))).toBe(false);
    expect(existsSync(join(paths.runsDir, "failed-run"))).toBe(false);
    expect(existsSync(join(paths.runsDir, "active-run"))).toBe(true);
  });

  it("[UC-SESSION-02-S08] parses cleanup retention windows", () => {
    expect(parseOlderThan("30m")).toBe(30 * 60 * 1000);
    expect(parseOlderThan("12h")).toBe(12 * 60 * 60 * 1000);
    expect(parseOlderThan("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseOlderThan("0d")).toBeUndefined();
    expect(parseOlderThan("7days")).toBeUndefined();
  });
});

function createPaths(): LocalStatePaths {
  const root = mkdtempSync(join(tmpdir(), "grovie-cleanup-"));
  tmpDirs.push(root);
  const paths = {
    root,
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir: join(root, "runs"),
    locksDir: join(root, "locks"),
    sessionsDir: join(root, "sessions"),
  };

  mkdirSync(paths.runsDir, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  return paths;
}

function writeRun(
  paths: LocalStatePaths,
  runId: string,
  input: {
    status: string;
    worktreePath: string;
    events: Array<Record<string, unknown>>;
  },
): void {
  const runDir = join(paths.runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(input.worktreePath, { recursive: true });
  writeFileSync(
    join(runDir, "metadata.json"),
    `${JSON.stringify({
      status: input.status,
      runId,
      repository: "fankaidev/grovie",
      issueNumber: 37,
      agentId: "coder@fankai-mac",
      branchName: "grovie/issue-37",
      worktreePath: input.worktreePath,
      createdAt: "2026-05-23T09:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
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
