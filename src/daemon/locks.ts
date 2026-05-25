import { resolveLocalIdentity } from "../identity.js";
import type { DaemonLock, ExecutionLock } from "../local-state.js";
import type { RunIssueResult } from "../run.js";
import type { DaemonInput } from "./types.js";
import { NO_LOCAL_AGENTS_MESSAGE } from "./types.js";

export function acquireDaemonLock(input: Pick<DaemonInput, "localState" | "now">) {
  const identity = resolveLocalIdentity();
  return input.localState?.acquireDaemonLock?.(identity.machineId, input.now?.() ?? new Date()) ?? {
    ok: true as const,
    lock: undefined,
  };
}

export function validateLocalAgents(input: Pick<DaemonInput, "localAgents">): RunIssueResult | undefined {
  if (input.localAgents !== undefined && input.localAgents.length === 0) {
    return {
      exitCode: 1,
      stderr: NO_LOCAL_AGENTS_MESSAGE,
    };
  }

  return undefined;
}

export function isConfiguredLocalAgent(input: Pick<DaemonInput, "localAgents">, agentId: string): boolean {
  return input.localAgents === undefined || input.localAgents.some((agent) => agent.agentId === agentId);
}

export function releaseDaemonLock(input: Pick<DaemonInput, "localState">, lock: DaemonLock | undefined): void {
  if (lock !== undefined) {
    input.localState?.releaseDaemonLock?.(lock);
  }
}

export function releaseExecutionLock(input: Pick<DaemonInput, "localState">, lock: ExecutionLock | undefined): void {
  if (lock !== undefined) {
    input.localState?.releaseExecutionLock?.(lock);
  }
}
