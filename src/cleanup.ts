import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpawnCommandRunner, type CommandRunner } from "./github.js";
import type { LocalStatePaths } from "./local-state.js";
import { listLocalRuns, type LocalRunSummary } from "./status.js";

export type CleanupLocalStateInput = {
  paths: LocalStatePaths;
  dryRun?: boolean;
  includeLogs?: boolean;
  olderThanMs?: number;
  now?: Date;
  runner?: CommandRunner;
};

export type CleanupLocalStateResult = {
  dryRun: boolean;
  removedWorktrees: CleanupAction[];
  removedRunDirs: CleanupAction[];
  skipped: CleanupSkip[];
};

export type CleanupAction = {
  path: string;
  runId: string;
  reason: string;
};

export type CleanupSkip = {
  path: string;
  runId: string;
  reason: string;
};

type SessionGroup = {
  worktreePath: string;
  runs: LocalRunSummary[];
};

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export function cleanupLocalState(input: CleanupLocalStateInput): CleanupLocalStateResult {
  const dryRun = input.dryRun === true;
  const includeLogs = input.includeLogs === true;
  const now = input.now ?? new Date();
  const runner = input.runner ?? new SpawnCommandRunner();
  const runs = listLocalRuns(input.paths.runsDir, { now });
  const result: CleanupLocalStateResult = {
    dryRun,
    removedWorktrees: [],
    removedRunDirs: [],
    skipped: [],
  };

  for (const group of groupRunsByWorktree(runs)) {
    const representative = group.runs[0];

    if (representative === undefined) {
      continue;
    }

    const skipReason = worktreeSkipReason(group.runs, input.olderThanMs, now);

    if (skipReason !== undefined) {
      result.skipped.push({
        path: group.worktreePath,
        runId: representative.runId,
        reason: skipReason,
      });
      continue;
    }

    result.removedWorktrees.push({
      path: group.worktreePath,
      runId: representative.runId,
      reason: "completed session worktree",
    });

    if (!dryRun) {
      removeWorktree(group.worktreePath, representative.repositoryCachePath, runner);
      appendCleanupEvents(group.runs, "worktree.cleaned", { worktreePath: group.worktreePath });
    }
  }

  if (includeLogs) {
    for (const run of runs) {
      const skipReason = runDirSkipReason(run, input.olderThanMs, now);

      if (skipReason !== undefined) {
        result.skipped.push({
          path: run.runDir,
          runId: run.runId,
          reason: skipReason,
        });
        continue;
      }

      result.removedRunDirs.push({
        path: run.runDir,
        runId: run.runId,
        reason: "terminal run directory",
      });

      if (!dryRun) {
        appendCleanupEvent(run, "run.cleaned", { runDir: run.runDir });
        rmSync(run.runDir, { recursive: true, force: true });
      }
    }
  }

  return result;
}

export function renderCleanupResult(result: CleanupLocalStateResult): string {
  const action = result.dryRun ? "Would remove" : "Removed";
  return [
    "grovie runs cleanup",
    "",
    `${action} worktrees: ${result.removedWorktrees.length}`,
    `${action} run directories: ${result.removedRunDirs.length}`,
    `Skipped: ${result.skipped.length}`,
    ...renderActions("Worktrees", result.removedWorktrees),
    ...renderActions("Run directories", result.removedRunDirs),
    ...renderSkips(result.skipped),
  ].join("\n");
}

export function parseOlderThan(value: string): number | undefined {
  const match = /^(?<amount>[1-9]\d*)(?<unit>[mhd])$/.exec(value);

  if (match?.groups === undefined) {
    return undefined;
  }

  const amount = Number(match.groups.amount);

  if (match.groups.unit === "m") {
    return amount * 60 * 1000;
  }

  if (match.groups.unit === "h") {
    return amount * 60 * 60 * 1000;
  }

  return amount * 24 * 60 * 60 * 1000;
}

function groupRunsByWorktree(runs: LocalRunSummary[]): SessionGroup[] {
  const groups = new Map<string, LocalRunSummary[]>();

  for (const run of runs) {
    if (run.worktreePath === undefined) {
      continue;
    }

    groups.set(run.worktreePath, [...(groups.get(run.worktreePath) ?? []), run]);
  }

  return [...groups.entries()].map(([worktreePath, groupedRuns]) => ({
    worktreePath,
    runs: groupedRuns,
  }));
}

function worktreeSkipReason(runs: LocalRunSummary[], olderThanMs: number | undefined, now: Date): string | undefined {
  if (runs.some((run) => run.status !== "succeeded")) {
    return "session has non-succeeded runs";
  }

  if (runs.some((run) => !isOldEnough(run, olderThanMs, now))) {
    return "newer than retention window";
  }

  const worktreePath = runs.find((run) => run.worktreePath !== undefined)?.worktreePath;

  if (worktreePath === undefined || !existsSync(worktreePath)) {
    return "worktree missing";
  }

  return undefined;
}

function runDirSkipReason(run: LocalRunSummary, olderThanMs: number | undefined, now: Date): string | undefined {
  if (!TERMINAL_STATUSES.has(run.status)) {
    return "run is not terminal";
  }

  return isOldEnough(run, olderThanMs, now) ? undefined : "newer than retention window";
}

function isOldEnough(run: LocalRunSummary, olderThanMs: number | undefined, now: Date): boolean {
  if (olderThanMs === undefined) {
    return true;
  }

  const timestamp = run.endedAt ?? run.lastEventTime ?? run.createdAt;

  if (timestamp === undefined) {
    return false;
  }

  const time = new Date(timestamp);

  if (Number.isNaN(time.getTime())) {
    return false;
  }

  return now.getTime() - time.getTime() >= olderThanMs;
}

function removeWorktree(path: string, repositoryCachePath: string | undefined, runner: CommandRunner): void {
  if (!existsSync(path)) {
    return;
  }

  if (repositoryCachePath !== undefined && existsSync(repositoryCachePath)) {
    const result = runner.run("git", ["-C", repositoryCachePath, "worktree", "remove", "--force", path]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `git worktree remove failed with exit code ${result.exitCode}.`);
    }

    return;
  }

  rmSync(path, { recursive: true, force: true });
}

function appendCleanupEvents(runs: LocalRunSummary[], type: string, data: Record<string, unknown>): void {
  for (const run of runs) {
    appendCleanupEvent(run, type, data);
  }
}

function appendCleanupEvent(run: LocalRunSummary, type: string, data: Record<string, unknown>): void {
  writeFileSync(
    join(run.runDir, "events.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      data,
    })}\n`,
    {
      encoding: "utf8",
      flag: "a",
    },
  );
}

function renderActions(title: string, actions: CleanupAction[]): string[] {
  if (actions.length === 0) {
    return [];
  }

  return [
    `${title}:`,
    ...actions.map((action) => `  - ${action.path} (${action.runId}; ${action.reason})`),
  ];
}

function renderSkips(skips: CleanupSkip[]): string[] {
  if (skips.length === 0) {
    return [];
  }

  return [
    "Skipped artifacts:",
    ...skips.map((skip) => `  - ${skip.path} (${skip.runId}; ${skip.reason})`),
  ];
}
