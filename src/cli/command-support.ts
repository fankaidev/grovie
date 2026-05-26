import type { AgentHealth } from "../agent-health.js";
import type { GrovieConfig } from "../config.js";
import type { GitHubGateway } from "../github.js";
import { createRuntime, type RuntimeAvailability, type RuntimeName } from "../runtime.js";
import type { CliContext, CliResult } from "./types.js";

export function checkRuntimeAvailability(context: CliContext, runtime: RuntimeName): RuntimeAvailability {
  if (context.runtimeAvailabilityChecker !== undefined) {
    return context.runtimeAvailabilityChecker(runtime);
  }

  if (context.runtime?.name === runtime) {
    return context.runtime.checkAvailability();
  }

  return createRuntime(runtime).checkAvailability();
}

export function startDaemonProcess(args: string[], context: CliContext): CliResult {
  const result = context.daemonLifecycle.start({
    root: context.localState.getPaths().root,
    args,
  });

  if (!result.ok) {
    return {
      exitCode: 1,
      stderr: result.message,
    };
  }

  return {
    exitCode: 0,
    stdout: [
      "grovie daemon start",
      "",
      `Started Grovie daemon pid ${result.state.pid}.`,
      `State: ${result.state.statePath}`,
      `Stdout log: ${result.state.stdoutPath}`,
      `Stderr log: ${result.state.stderrPath}`,
    ].join("\n"),
  };
}

export function renderRuntimeHealth(runtimes: RuntimeAvailability[]): string[] {
  return [
    "Runtimes:",
    ...runtimes.map((runtime) => `- ${runtime.runtime} command=${runtime.command}: ${runtime.message}`),
  ];
}

export function renderConfiguredAgents(agents: AgentHealth[]): string[] {
  if (agents.length === 0) {
    return ["Configured agents: none"];
  }

  return [
    "Configured agents:",
    ...agents.map((agent) => `- ${agent.agentId} (${agent.runtime}, command=${agent.availability.command}): ${agent.availability.message}`),
  ];
}

export function renderUnavailableAgents(unavailableAgents: AgentHealth[]): string {
  return [
    "Unavailable configured agents:",
    ...unavailableAgents.map((agent) => `- ${agent.agentId}: ${agent.availability.message}`),
  ].join("\n");
}

export function renderGlobalConfigSource(path: string, watchedRepositoryCount: number): string {
  const repositoryText = watchedRepositoryCount === 1 ? "1 watched repository" : `${watchedRepositoryCount} watched repositories`;
  return `${path} (${repositoryText}).`;
}

export function resolveQueueTrustedAuthors(config: GrovieConfig, github: GitHubGateway): { ok: true; value: string[] } | { ok: false; message: string } {
  const configured = config.trust?.trustedAuthors.filter((author) => author.trim().length > 0) ?? [];

  if (configured.length > 0) {
    return {
      ok: true,
      value: configured,
    };
  }

  const authenticated = github.getAuthenticatedUser();

  if (!authenticated.ok) {
    return {
      ok: false,
      message: `Could not resolve default trusted issue creator from gh login: ${authenticated.error.message}`,
    };
  }

  return {
    ok: true,
    value: [authenticated.value.login],
  };
}

export function readStringOption(
  args: string[],
  name: string,
): { ok: true; value: string | undefined } | { ok: false; result: CliResult } {
  const index = args.indexOf(name);

  if (index === -1) {
    return {
      ok: true,
      value: undefined,
    };
  }

  const value = args[index + 1];

  if (value === undefined || value.startsWith("-")) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: `Missing value for ${name}.`,
      },
    };
  }

  return {
    ok: true,
    value,
  };
}

export function readNumberOption(
  args: string[],
  name: string,
): { ok: true; value: number | undefined } | { ok: false; result: CliResult } {
  const option = readStringOption(args, name);

  if (!option.ok) {
    return option;
  }

  if (option.value === undefined) {
    return {
      ok: true,
      value: undefined,
    };
  }

  const value = Number(option.value);

  if (!Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: `Invalid value for ${name}. Expected a positive integer.`,
      },
    };
  }

  return {
    ok: true,
    value,
  };
}

export function errorResult(error: unknown): CliResult {
  return {
    exitCode: 1,
    stderr: error instanceof Error ? error.message : String(error),
  };
}

export function githubErrorResult(error: { message: string }): CliResult {
  return {
    exitCode: 1,
    stderr: error.message,
  };
}
