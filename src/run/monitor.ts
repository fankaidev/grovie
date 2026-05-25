import type { StateRepoConfig } from "../config.js";
import type { PreparedRun } from "../local-state.js";
import type { RuntimeMonitor } from "../runtime.js";
import { bestEffortStateSync } from "./state-sync.js";
import type { RunLocalState } from "./types.js";

export function mergeCancellationMonitor(
  localState: RunLocalState,
  run: PreparedRun,
  stateRepo: StateRepoConfig | undefined,
  monitor: RuntimeMonitor | undefined,
): RuntimeMonitor | undefined {
  if (monitor === undefined && localState.isRunCancellationRequested === undefined && stateRepo === undefined) {
    return undefined;
  }

  return {
    heartbeatIntervalMs: monitor?.heartbeatIntervalMs,
    onHeartbeat: async (event) => {
      bestEffortStateSync({
        localState,
        stateRepo,
        run,
        agentId: run.agentId,
      });
      await monitor?.onHeartbeat?.(event);
    },
    shouldCancel: async (event) => {
      if (localState.isRunCancellationRequested?.(run.runId) === true) {
        return true;
      }

      return await monitor?.shouldCancel?.(event) === true;
    },
  };
}
