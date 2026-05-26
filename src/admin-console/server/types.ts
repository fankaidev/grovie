import type { Server } from "node:http";
import type { RuntimeAvailabilityChecker } from "../../agent-health.js";
import type { DaemonLifecycle } from "../../daemon-lifecycle.js";
import type { LocalStatePaths } from "../../local-state.js";

export type AdminConsoleResolvedConfig = {
  enabled: boolean;
  host: string;
  port: number;
};

export type StartedAdminConsole = {
  server: AdminConsoleServerHandle;
  url: string;
};

export type AdminConsoleServerHandle = Pick<Server, "close" | "closeAllConnections">;

export type AdminConsoleContext = {
  paths: LocalStatePaths;
  daemonLifecycle: DaemonLifecycle;
  runtimeAvailabilityChecker?: RuntimeAvailabilityChecker;
  adminWebAssetsDir?: string;
};
