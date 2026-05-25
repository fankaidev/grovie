import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentHealth } from "./agent-health.js";
import type { AdminConsoleResolvedConfig } from "./admin-console.js";
import type { WatchedRepository } from "./config.js";
import type { DaemonLifecycleStatus } from "./daemon-lifecycle.js";
import type { LocalStatePaths } from "./local-state.js";

export { renderLocalStatusOverview, renderRunDetail, renderRunsList } from "./status/render.js";

export type RunEvent = {
  timestamp?: string;
  type: string;
  data?: Record<string, unknown>;
};

export type LocalRunSummary = {
  runId: string;
  runDir: string;
  repository?: string;
  issueNumber?: number;
  agentId?: string;
  runtime?: string;
  status: "preparing" | "prepared" | "running" | "interrupting" | "interrupted" | "resuming" | "rejected" | "succeeded" | "failed" | "canceled" | "stale" | "unknown";
  branchName?: string;
  localBranchName?: string;
  repositoryCachePath?: string;
  worktreePath?: string;
  stdoutPath: string;
  stderrPath: string;
  promptPath: string;
  taskPath: string;
  startedAt?: string;
  endedAt?: string;
  lastEventTime?: string;
  lastEventType?: string;
  createdAt?: string;
  runRequest?: {
    sourceRunId?: string;
    reason?: string;
  };
  runtimeSessionRef?: {
    runtime: string;
    sessionId: string;
    createdAt?: string;
    updatedAt?: string;
  };
  resultLinks: string[];
  events: RunEvent[];
};

type RunMetadata = {
  status?: string;
  runId?: string;
  repository?: string;
  issueNumber?: number;
  agentId?: string;
  branchName?: string;
  localBranchName?: string;
  repositoryCachePath?: string;
  worktreePath?: string;
  createdAt?: string;
  runRequest?: {
    sourceRunId?: string;
    reason?: string;
  };
  runtimeSessionRef?: {
    runtime?: string;
    sessionId?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};

export type LocalStatusOverviewInput = {
  runs: LocalRunSummary[];
  daemonStatus: DaemonLifecycleStatus;
  adminConsole?: AdminConsoleResolvedConfig;
  agentHealth?: AgentHealth[];
  watchedRepositories: WatchedRepository[];
  paths: LocalStatePaths;
};

export type ListLocalRunsOptions = {
  now?: Date;
  staleAfterMs?: number;
};

const TERMINAL_STATUS_BY_EVENT: Record<string, LocalRunSummary["status"] | undefined> = {
  "prepare.failed": "failed",
  "run.succeeded": "succeeded",
  "run.failed": "failed",
  "run.canceled": "canceled",
  "run.interrupted": "interrupted",
  "run.rejected": "rejected",
};

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

export function listLocalRuns(runsDir: string, options: ListLocalRunsOptions = {}): LocalRunSummary[] {
  if (!existsSync(runsDir)) {
    return [];
  }

  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readLocalRun(join(runsDir, entry.name), entry.name, now, staleAfterMs))
    .sort(compareRunsNewestFirst);
}

export function findLocalRun(runsDir: string, runId: string, options: ListLocalRunsOptions = {}): LocalRunSummary | undefined {
  return listLocalRuns(runsDir, options).find((run) => run.runId === runId);
}

function readLocalRun(runDir: string, directoryRunId: string, now: Date, staleAfterMs: number): LocalRunSummary {
  const metadata = readMetadata(join(runDir, "metadata.json"));
  const events = readEvents(join(runDir, "events.jsonl"));
  const lastEvent = events.at(-1);
  const runId = metadata.runId ?? directoryRunId;

  return {
    runId,
    runDir,
    repository: metadata.repository,
    issueNumber: metadata.issueNumber,
    agentId: metadata.agentId,
    runtime: findRuntime(events),
    status: deriveRunStatus(metadata.status, events, now, staleAfterMs),
    branchName: metadata.branchName,
    localBranchName: metadata.localBranchName,
    repositoryCachePath: metadata.repositoryCachePath,
    worktreePath: metadata.worktreePath,
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
    promptPath: join(runDir, "prompt.md"),
    taskPath: join(runDir, "task.json"),
    startedAt: findStartedAt(events),
    endedAt: findEndedAt(events),
    lastEventTime: lastEvent?.timestamp ?? metadata.createdAt ?? fallbackMtime(runDir),
    lastEventType: lastEvent?.type,
    createdAt: metadata.createdAt,
    runRequest: metadata.runRequest,
    runtimeSessionRef: normalizeRuntimeSessionRef(metadata.runtimeSessionRef),
    resultLinks: findResultLinks(events),
    events,
  };
}

function normalizeRuntimeSessionRef(value: RunMetadata["runtimeSessionRef"]): LocalRunSummary["runtimeSessionRef"] {
  if (value === undefined || typeof value.runtime !== "string" || typeof value.sessionId !== "string") {
    return undefined;
  }

  return {
    runtime: value.runtime,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readMetadata(path: string): RunMetadata {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

    if (parsed === null || typeof parsed !== "object") {
      return {};
    }

    return parsed as RunMetadata;
  } catch {
    return {};
  }
}

function readEvents(path: string): RunEvent[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;

        if (parsed === null || typeof parsed !== "object") {
          return [];
        }

        const event = parsed as Partial<RunEvent>;

        if (typeof event.type !== "string") {
          return [];
        }

        return [
          {
            timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
            type: event.type,
            data: isRecord(event.data) ? event.data : undefined,
          },
        ];
      } catch {
        return [];
      }
    });
}

function deriveRunStatus(
  metadataStatus: string | undefined,
  events: RunEvent[],
  now: Date,
  staleAfterMs: number,
): LocalRunSummary["status"] {
  if (metadataStatus === "resuming") {
    return "interrupted";
  }

  if (metadataStatus === "interrupting" || metadataStatus === "interrupted" || metadataStatus === "rejected") {
    return metadataStatus;
  }

  for (const event of [...events].reverse()) {
    const terminalStatus = TERMINAL_STATUS_BY_EVENT[event.type];

    if (terminalStatus !== undefined) {
      return terminalStatus;
    }

    if (event.type === "runtime.finished") {
      return statusFromRuntimeFinished(event);
    }
  }

  const startedEvent = [...events].reverse().find((event) => event.type === "runtime.started" || event.type === "run.started");

  if (startedEvent !== undefined) {
    return isStale(startedEvent, events.at(-1), now, staleAfterMs) ? "stale" : "running";
  }

  if (metadataStatus === "preparing" || metadataStatus === "prepared") {
    return metadataStatus;
  }

  if (metadataStatus === "running") {
    return metadataStatus;
  }

  return "unknown";
}

function statusFromRuntimeFinished(event: RunEvent): LocalRunSummary["status"] {
  if (event.data?.canceled === true) {
    return "canceled";
  }

  return event.data?.exitCode === 0 ? "succeeded" : "failed";
}

function isStale(startedEvent: RunEvent, lastEvent: RunEvent | undefined, now: Date, staleAfterMs: number): boolean {
  const eventTime = parseTime(lastEvent?.timestamp ?? startedEvent.timestamp);

  if (eventTime === undefined) {
    return false;
  }

  return now.getTime() - eventTime.getTime() > staleAfterMs;
}

function compareRunsNewestFirst(left: LocalRunSummary, right: LocalRunSummary): number {
  return sortTime(right) - sortTime(left) || left.runId.localeCompare(right.runId);
}

function sortTime(run: LocalRunSummary): number {
  return parseTime(run.lastEventTime)?.getTime() ?? 0;
}

function parseTime(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? undefined : time;
}

function fallbackMtime(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function findRuntime(events: RunEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (typeof event.data?.runtime === "string") {
      return event.data.runtime;
    }
  }

  return undefined;
}

function findStartedAt(events: RunEvent[]): string | undefined {
  return events.find((event) => event.type === "run.started" || event.type === "runtime.started")?.timestamp;
}

function findEndedAt(events: RunEvent[]): string | undefined {
  return [...events].reverse().find((event) =>
    event.type === "run.succeeded"
    || event.type === "run.failed"
    || event.type === "run.canceled"
    || event.type === "runtime.finished"
    || event.type === "prepare.failed"
  )?.timestamp;
}

function findResultLinks(events: RunEvent[]): string[] {
  return Array.from(new Set(events.flatMap((event) => [
    stringData(event, "url"),
    stringData(event, "pullRequestUrl"),
    stringData(event, "commentUrl"),
  ].filter((value): value is string => value !== undefined))));
}

function stringData(event: RunEvent, key: string): string | undefined {
  const value = event.data?.[key];

  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
