import { hostname } from "node:os";
import type { RuntimeName } from "./runtime.js";

export type AgentMetadata = {
  agentId: string;
  name: string;
  machineId: string;
  runtime: RuntimeName;
  instructions?: string;
  model?: string;
  args: string[];
  envKeys: string[];
};

export type LocalIdentity = {
  machineId: string;
};

export function slugifyIdentityPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveMachineId(hostnameValue = hostname()): string {
  const machineId = slugifyIdentityPart(hostnameValue);

  if (machineId.length === 0) {
    throw new Error("Could not resolve machine id from hostname.");
  }

  return machineId;
}

export function buildAgentId(agentName: string, machineId: string): string {
  const agentSlug = slugifyIdentityPart(agentName);
  const machineSlug = slugifyIdentityPart(machineId);

  if (agentSlug.length === 0) {
    throw new Error("Agent name must contain at least one letter or number.");
  }

  if (machineSlug.length === 0) {
    throw new Error("Machine id must contain at least one letter or number.");
  }

  return `${agentSlug}@${machineSlug}`;
}

export function resolveLocalIdentity(hostnameValue = hostname()): LocalIdentity {
  const machineId = resolveMachineId(hostnameValue);

  return {
    machineId,
  };
}
