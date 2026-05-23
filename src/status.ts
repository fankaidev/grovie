import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
  status: "preparing" | "prepared" | "active" | "completed" | "failed" | "canceled" | "stale" | "unknown";
  branchName?: string;
  localBranchName?: string;
  worktreePath?: string;
  stdoutPath: string;
  stderrPath: string;
  lastEventTime?: string;
  lastEventType?: string;
  createdAt?: string;
  events: RunEvent[];
};

type RunMetadata = {
  status?: string;
  runId?: string;
  repository?: string;
  issueNumber?: number;
  branchName?: string;
  localBranchName?: string;
  worktreePath?: string;
  createdAt?: string;
};

export type ListLocalRunsOptions = {
  now?: Date;
  staleAfterMs?: number;
};

const TERMINAL_STATUS_BY_EVENT: Record<string, LocalRunSummary["status"] | undefined> = {
  "prepare.failed": "failed",
  "run.succeeded": "completed",
  "run.failed": "failed",
  "run.canceled": "canceled",
};

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const RECENT_EVENT_LIMIT = 5;

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

export function renderRunsList(runs: LocalRunSummary[], title = "grovie runs list"): string {
  if (runs.length === 0) {
    return [title, "", "No local runs found."].join("\n");
  }

  return [
    title,
    "",
    ...runs.map((run) =>
      [
        `- ${run.runId}`,
        `  Status: ${run.status}`,
        `  Issue: ${renderIssue(run)}`,
        `  Branch: ${run.branchName ?? "(unknown)"}`,
        `  Last event: ${renderLastEvent(run)}`,
        `  Logs: stdout=${run.stdoutPath} stderr=${run.stderrPath}`,
      ].join("\n"),
    ),
  ].join("\n");
}

export function renderRunDetail(run: LocalRunSummary): string {
  return [
    "grovie runs show",
    "",
    `Run id: ${run.runId}`,
    `Status: ${run.status}`,
    `Repository: ${run.repository ?? "(unknown)"}`,
    `Issue: ${run.issueNumber === undefined ? "(unknown)" : `#${run.issueNumber}`}`,
    `Branch: ${run.branchName ?? "(unknown)"}`,
    `Local branch: ${run.localBranchName ?? "(unknown)"}`,
    `Worktree: ${run.worktreePath ?? "(unknown)"}`,
    `Run directory: ${run.runDir}`,
    `Stdout log: ${run.stdoutPath}`,
    `Stderr log: ${run.stderrPath}`,
    `Last event: ${renderLastEvent(run)}`,
    "",
    "Recent events:",
    renderRecentEvents(run.events),
  ].join("\n");
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
    status: deriveRunStatus(metadata.status, events, now, staleAfterMs),
    branchName: metadata.branchName,
    localBranchName: metadata.localBranchName,
    worktreePath: metadata.worktreePath,
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
    lastEventTime: lastEvent?.timestamp ?? metadata.createdAt ?? fallbackMtime(runDir),
    lastEventType: lastEvent?.type,
    createdAt: metadata.createdAt,
    events,
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
    return isStale(startedEvent, events.at(-1), now, staleAfterMs) ? "stale" : "active";
  }

  if (metadataStatus === "preparing" || metadataStatus === "prepared") {
    return metadataStatus;
  }

  return "unknown";
}

function statusFromRuntimeFinished(event: RunEvent): LocalRunSummary["status"] {
  if (event.data?.canceled === true) {
    return "canceled";
  }

  return event.data?.exitCode === 0 ? "completed" : "failed";
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

function renderIssue(run: LocalRunSummary): string {
  if (run.repository === undefined && run.issueNumber === undefined) {
    return "(unknown)";
  }

  return `${run.repository ?? "(unknown)"}${run.issueNumber === undefined ? "" : `#${run.issueNumber}`}`;
}

function renderLastEvent(run: LocalRunSummary): string {
  if (run.lastEventTime === undefined && run.lastEventType === undefined) {
    return "(none)";
  }

  if (run.lastEventType === undefined) {
    return run.lastEventTime ?? "(none)";
  }

  if (run.lastEventTime === undefined) {
    return run.lastEventType;
  }

  return `${run.lastEventTime} ${run.lastEventType}`;
}

function renderRecentEvents(events: RunEvent[]): string {
  if (events.length === 0) {
    return "  (none)";
  }

  return events
    .slice(-RECENT_EVENT_LIMIT)
    .map((event) => `  - ${event.timestamp ?? "(no timestamp)"} ${event.type}${renderEventData(event.data)}`)
    .join("\n");
}

function renderEventData(data: Record<string, unknown> | undefined): string {
  if (data === undefined || Object.keys(data).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(data)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
