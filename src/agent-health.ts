import type { GlobalGrovieConfig } from "./config.js";
import { resolveConfiguredAgents } from "./config.js";
import type { AgentMetadata } from "./identity.js";
import { createRuntime, type RuntimeAvailability, type RuntimeName } from "./runtime.js";

export type AgentHealth = AgentMetadata & {
  availability: RuntimeAvailability;
};

export type RuntimeAvailabilityChecker = (runtime: RuntimeName) => RuntimeAvailability;

export function getConfiguredAgentHealth(
  config: GlobalGrovieConfig,
  machineId: string,
  checkAvailability: RuntimeAvailabilityChecker = defaultRuntimeAvailabilityChecker,
): AgentHealth[] {
  const availabilityByRuntime = new Map<RuntimeName, RuntimeAvailability>();

  return resolveConfiguredAgents(config, machineId).map((agent) => {
    let availability = availabilityByRuntime.get(agent.runtime);

    if (availability === undefined) {
      availability = checkAvailability(agent.runtime);
      availabilityByRuntime.set(agent.runtime, availability);
    }

    return {
      ...agent,
      availability,
    };
  });
}

function defaultRuntimeAvailabilityChecker(runtime: RuntimeName): RuntimeAvailability {
  return createRuntime(runtime).checkAvailability();
}
