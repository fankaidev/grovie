import type { AgentHealth, AgentVerificationResult } from "../agent-health.js";
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
    ...runtimes.map((runtime) => `- ${runtime.runtime} command=${runtime.command}: ${renderCliAvailabilityMessage(runtime)}`),
  ];
}

export function renderConfiguredAgents(agents: AgentHealth[]): string[] {
  if (agents.length === 0) {
    return ["Configured agents: none"];
  }

  return [
    "Configured agents:",
    ...agents.map((agent) => `- ${agent.agentId} (${agent.runtime}, command=${agent.availability.command}): ${renderCliAvailabilityMessage(agent.availability)}`),
  ];
}

export function renderUnavailableAgents(unavailableAgents: AgentHealth[]): string {
  return [
    "Unavailable configured agents:",
    ...unavailableAgents.map((agent) => `- ${agent.agentId}: ${agent.availability.message}`),
  ].join("\n");
}

export function renderAgentVerificationResults(results: AgentVerificationResult[]): string[] {
  if (results.length === 0) {
    return ["Agent execution verification: no configured agents"];
  }

  return [
    "Agent execution verification:",
    "This check runs real agent invocations and may use network access or provider credits.",
    ...results.map((result) => renderAgentVerificationResult(result)),
  ];
}

export function renderAgentVerificationResult(result: AgentVerificationResult): string {
  return [
    `- ${result.agent.agentId} (${result.agent.runtime}${result.agent.model === undefined ? "" : `, model=${result.agent.model}`}): ${result.ok ? "verified" : `failed: ${redactVerificationMessage(result.message, result.agent.envKeys)}`}`,
    `  command: ${formatCommandShape(result.command)}`,
    `  envKeys: ${result.agent.envKeys.length === 0 ? "none" : result.agent.envKeys.join(", ")}`,
  ].join("\n");
}

export function renderFailedAgentVerifications(results: AgentVerificationResult[]): string {
  return [
    "Failed configured agent verifications:",
    ...results.filter((result) => !result.ok).map((result) => `- ${result.agent.agentId}: ${redactVerificationMessage(result.message, result.agent.envKeys)}`),
  ].join("\n");
}

function renderCliAvailabilityMessage(runtime: RuntimeAvailability): string {
  return runtime.available && runtime.message.startsWith("available")
    ? `CLI ${runtime.message}`
    : runtime.message;
}

function formatCommandShape(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function redactVerificationMessage(message: string, envKeys: readonly string[]): string {
  let redacted = message;

  for (const key of envKeys) {
    const value = process.env[key];
    if (value !== undefined && value.length >= 4) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }

  return redacted
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL)[A-Z0-9_]*)\b\s*[:=]\s*["']?[^"'\s]+["']?/g, "$1=[REDACTED]")
    .replace(/\b(token|key|secret|password|database_url)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
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

export type CliArgSpec = {
  positionals?: {
    min?: number;
    max?: number;
    label?: string;
  };
  valueOptions?: string[];
  flags?: string[];
};

export function validateCliArgs(args: string[], spec: CliArgSpec = {}): { ok: true } | { ok: false; result: CliResult } {
  const valueOptions = new Set(spec.valueOptions ?? []);
  const flags = new Set(spec.flags ?? []);
  const seenOptions = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg.startsWith("-")) {
      if (valueOptions.has(arg)) {
        if (seenOptions.has(arg)) {
          return invalidArgs(`Duplicate option: ${arg}`);
        }

        const value = args[index + 1];

        if (value === undefined || value.startsWith("-")) {
          return invalidArgs(`Missing value for ${arg}.`);
        }

        seenOptions.add(arg);
        index += 1;
        continue;
      }

      if (flags.has(arg)) {
        if (seenOptions.has(arg)) {
          return invalidArgs(`Duplicate option: ${arg}`);
        }

        seenOptions.add(arg);
        continue;
      }

      return invalidArgs(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  const min = spec.positionals?.min ?? 0;
  const max = spec.positionals?.max ?? min;

  if (positionals.length < min) {
    return invalidArgs(`Missing ${spec.positionals?.label ?? "argument"}.`);
  }

  if (positionals.length > max) {
    return invalidArgs(`Unexpected argument: ${positionals[max]}`);
  }

  return {
    ok: true,
  };
}

function invalidArgs(message: string): { ok: false; result: CliResult } {
  return {
    ok: false,
    result: {
      exitCode: 1,
      stderr: message,
    },
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
