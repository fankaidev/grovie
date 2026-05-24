import type { GlobalGrovieConfig, LoadedGlobalConfig, WatchedRepository } from "./config.js";
import type { DaemonActivityEntry } from "./daemon-activity.js";
import type { DaemonLifecycleStatus } from "./daemon-lifecycle.js";
import type { RunCancellation } from "./local-state.js";
import type { RuntimeAvailability } from "./runtime.js";
import type { LocalRunSummary, RunEvent } from "./status.js";

export type { LocalRunSummary, RunEvent } from "./status.js";

export type AdminApiErrorCode = "not_found" | "invalid_stream" | "not_cancelable";

export type AdminApiErrorResponse = {
  error: AdminApiErrorCode;
  message: string;
};

export type AdminConsoleRootHealthResponse = {
  ok: true;
  service: "grovie-admin-console";
};

export type AdminApiDaemonStatus =
  | Extract<DaemonLifecycleStatus, { status: "stopped" }>
  | {
    status: Extract<DaemonLifecycleStatus, { status: "running" | "stale" }>["status"];
    state: Omit<Extract<DaemonLifecycleStatus, { status: "running" | "stale" }>["state"], "token">;
  };

export type AdminApiHealthResponse = {
  ok: true;
  daemon: AdminApiDaemonStatus;
  runtime: RuntimeAvailability;
};

export type AdminApiConfigResponse = {
  path: LoadedGlobalConfig["path"];
  config: GlobalGrovieConfig;
};

export type AdminApiRepositoriesResponse = {
  repositories: WatchedRepository[];
};

export type AdminApiRunsResponse = {
  runs: LocalRunSummary[];
};

export type AdminApiRunDetailResponse = {
  run: LocalRunSummary;
};

export type AdminApiRunEventsResponse = {
  runId: string;
  events: RunEvent[];
};

export type AdminLogStream = "stdout" | "stderr";

export type AdminApiRunLogResponse = {
  runId: string;
  stream: AdminLogStream;
  path: string;
  content: string;
};

export type AdminApiRunLogStreamQuery = {
  stream: AdminLogStream;
};

export type AdminApiRunLogStreamEvent = {
  event: "snapshot" | "append";
  data: AdminApiRunLogResponse;
};

export type AdminApiActivityResponse = {
  activity: DaemonActivityEntry[];
};

export type AdminApiCancelRunRequest = Record<string, never>;

export type AdminApiCancelRunResponse = {
  ok: true;
  cancellation: RunCancellation;
};
