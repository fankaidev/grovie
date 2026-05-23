import { slugifyIdentityPart } from "./identity.js";

export const AGENT_LABEL_PREFIX = "agent:";

export type ParsedAgentId = {
  agentSlug: string;
  machineId: string;
};

export function parseAgentId(agentId: string): ParsedAgentId {
  const parts = agentId.split("@");

  if (parts.length !== 2) {
    throw new Error(`Invalid agent id "${agentId}". Expected <agent-slug>@<machine-slug>.`);
  }

  const [agentSlug, machineId] = parts;
  const normalizedAgent = slugifyIdentityPart(agentSlug ?? "");
  const normalizedMachine = slugifyIdentityPart(machineId ?? "");

  if (normalizedAgent.length === 0 || normalizedMachine.length === 0) {
    throw new Error(`Invalid agent id "${agentId}". Expected <agent-slug>@<machine-slug>.`);
  }

  if (agentSlug !== normalizedAgent || machineId !== normalizedMachine) {
    throw new Error(`Invalid agent id "${agentId}". Use normalized id "${normalizedAgent}@${normalizedMachine}".`);
  }

  return {
    agentSlug: normalizedAgent,
    machineId: normalizedMachine,
  };
}

export function buildAgentLabel(agentId: string): string {
  parseAgentId(agentId);
  return `${AGENT_LABEL_PREFIX}${agentId}`;
}

export function getAssignedAgentIds(labels: string[]): string[] {
  return labels
    .filter((label) => label.startsWith(AGENT_LABEL_PREFIX))
    .map((label) => label.slice(AGENT_LABEL_PREFIX.length))
    .filter((agentId) => {
      try {
        parseAgentId(agentId);
        return true;
      } catch {
        return false;
      }
    });
}

export function isAssignedToLocalMachine(labels: string[], machineId: string): boolean {
  const normalizedMachine = slugifyIdentityPart(machineId);

  return getAssignedAgentIds(labels).some((agentId) => parseAgentId(agentId).machineId === normalizedMachine);
}
