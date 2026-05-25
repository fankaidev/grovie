import { resolveLocalIdentity } from "../identity.js";

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveSummaryMachineId(agentId: string): string {
  return agentId.includes("@") ? agentId.split("@")[1] ?? resolveLocalIdentity().machineId : resolveLocalIdentity().machineId;
}

export function isReviewerRun(agentId: string): boolean {
  return agentId === "reviewer" || agentId.startsWith("reviewer@");
}
