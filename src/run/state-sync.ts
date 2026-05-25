import type { StateRepoConfig } from "../config.js";
import type { PreparedRun } from "../local-state.js";
import { syncStateRepository } from "../state-repo.js";
import type { RunLocalState, RunStateRepoSummary } from "./types.js";
import { resolveSummaryMachineId } from "./helpers.js";

export function bestEffortStateSync(input: {
  localState: RunLocalState;
  stateRepo: StateRepoConfig | undefined;
  run: PreparedRun;
  agentId: string;
  summary?: Record<string, unknown>;
}): RunStateRepoSummary | undefined {
  if (input.stateRepo === undefined) {
    return undefined;
  }

  const machineId = resolveSummaryMachineId(input.agentId);
  const result = syncStateRepository({
    config: input.stateRepo,
    paths: input.localState.getPaths(),
    machineId,
    agentId: input.agentId,
    run: input.run,
    summary: input.summary,
  });

  input.localState.appendEvent(input.run, result.ok ? "state_repo.synced" : "state_repo.pending", result.ok
    ? {
      committed: result.committed,
      path: result.path,
    }
    : {
      pendingPath: result.pendingPath,
      message: result.message,
    });

  if (result.ok) {
    return result.path === undefined
      ? undefined
      : {
        status: "synced",
        target: renderStateRepoRunSummaryLink(input.stateRepo, input.run.runId),
      };
  }

  return {
    status: "pending",
    target: ".grovie-sync-pending.json",
  };
}

function renderStateRepoRunSummaryLink(config: StateRepoConfig, runId: string): string {
  return `https://github.com/${config.repository}/blob/${encodeURIComponent(config.branch)}/runs/${encodeURIComponent(runId)}/summary.json`;
}
