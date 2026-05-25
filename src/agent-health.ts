import type { GlobalGrovieConfig } from "./config.js";
import { resolveConfiguredAgents } from "./config.js";
import type { AgentMetadata } from "./identity.js";
import { createRuntime, SUPPORTED_RUNTIMES, type RuntimeAvailability, type RuntimeName } from "./runtime.js";

export type AgentHealth = AgentMetadata & {
  availability: RuntimeAvailability;
};

export type RuntimeAvailabilityChecker = (runtime: RuntimeName) => RuntimeAvailability;

export function getConfiguredAgentHealth(
  config: GlobalGrovieConfig,
  machineId: string,
  checkAvailability: RuntimeAvailabilityChecker = defaultRuntimeAvailabilityChecker,
): AgentHealth[] {
  const availabilityByRuntime = getRuntimeAvailabilityMap(checkAvailability);

  return resolveConfiguredAgents(config, machineId).map((agent) => {
    const availability = availabilityByRuntime.get(agent.runtime) ?? checkAvailability(agent.runtime);

    return {
      ...agent,
      availability,
    };
  });
}

export function getRuntimeHealth(
  checkAvailability: RuntimeAvailabilityChecker = defaultRuntimeAvailabilityChecker,
): RuntimeAvailability[] {
  return [...getRuntimeAvailabilityMap(checkAvailability).values()];
}

function getRuntimeAvailabilityMap(checkAvailability: RuntimeAvailabilityChecker): Map<RuntimeName, RuntimeAvailability> {
  return new Map(SUPPORTED_RUNTIMES.map((runtime) => [runtime, checkAvailability(runtime)]));
}

function defaultRuntimeAvailabilityChecker(runtime: RuntimeName): RuntimeAvailability {
  return createRuntime(runtime).checkAvailability();
}
