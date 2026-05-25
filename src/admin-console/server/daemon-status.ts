import type { AdminApiDaemonStatus } from "../../admin-api.js";
import type { DaemonLifecycleStatus } from "../../daemon-lifecycle.js";

export function renderApiDaemonStatus(status: DaemonLifecycleStatus): AdminApiDaemonStatus {
  if (status.status === "stopped") {
    return status;
  }

  return {
    status: status.status,
    state: {
      pid: status.state.pid,
      command: status.state.command,
      startedAt: status.state.startedAt,
      stdoutPath: status.state.stdoutPath,
      stderrPath: status.state.stderrPath,
      statePath: status.state.statePath,
    },
  };
}
