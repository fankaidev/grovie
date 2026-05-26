import type { AgentHealth, AgentVerificationResult } from "../agent-health.js";
import { getAssignedAgentIds, parseAgentId } from "../assignment.js";
import type { GrovieConfig } from "../config.js";
import { formatIssueReference, type GitHubGateway, parseIssueReference } from "../github.js";
import { resolveLocalIdentity } from "../identity.js";
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
    ...results.map((result) => [
      `- ${result.agent.agentId} (${result.agent.runtime}${result.agent.model === undefined ? "" : `, model=${result.agent.model}`}): ${result.ok ? "verified" : `failed: ${result.message}`}`,
      `  command: ${formatCommandShape(result.command)}`,
      `  envKeys: ${result.agent.envKeys.length === 0 ? "none" : result.agent.envKeys.join(", ")}`,
    ].join("\n")),
  ];
}

export function renderFailedAgentVerifications(results: AgentVerificationResult[]): string {
  return [
    "Failed configured agent verifications:",
    ...results.filter((result) => !result.ok).map((result) => `- ${result.agent.agentId}: ${result.message}`),
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

export function formatIssueRepository(reference: { owner: string; repo: string }): string {
  return `${reference.owner}/${reference.repo}`;
}

export function resolveManualRunAgent(input: {
  explicitAgentId: string | undefined;
  issueReference: { owner: string; repo: string; number: number };
  github: GitHubGateway;
  machineId: string;
}): { ok: true; agentId: string } | { ok: false; message: string } {
  if (input.explicitAgentId !== undefined) {
    parseAgentId(input.explicitAgentId);
    return {
      ok: true,
      agentId: input.explicitAgentId,
    };
  }

  const issueResult = input.github.readIssue(input.issueReference);

  if (!issueResult.ok) {
    return {
      ok: false,
      message: issueResult.error.message,
    };
  }

  const localAgentIds = getAssignedAgentIds(issueResult.value.labels)
    .filter((agentId) => agentId.endsWith(`@${input.machineId}`));

  if (localAgentIds.length === 0) {
    return {
      ok: false,
      message: `No local agent assignment found for ${formatIssueReference(input.issueReference)}. Pass --agent or add an agent:<name>@${input.machineId} label.`,
    };
  }

  if (localAgentIds.length > 1) {
    return {
      ok: false,
      message: `Multiple local agent assignments found for ${formatIssueReference(input.issueReference)}: ${localAgentIds.join(", ")}. Pass --agent to choose one.`,
    };
  }

  return {
    ok: true,
    agentId: localAgentIds[0] ?? "",
  };
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

export function enqueueDaemonRunRequest(input: {
  context: CliContext;
  repository: string;
  issueNumber: number;
  agentId: string;
  sourceRunId?: string;
  reason: "retry" | "rerun";
  title: string;
  action: string;
  mode: string;
}): CliResult {
  const identity = resolveLocalIdentity();
  const issueReference = parseIssueReference(`${input.repository}#${input.issueNumber}`);

  if (!issueReference.ok) {
    return githubErrorResult(issueReference.error);
  }

  if (input.context.localState.isDaemonRunning?.(identity.machineId) !== true) {
    return {
      exitCode: 1,
      stderr: `No Grovie daemon is running for machine ${identity.machineId}. Start one with \`grovie daemon start\`.`,
    };
  }

  if (input.context.localState.hasExecutionLock?.({
    repository: input.repository,
    issueNumber: input.issueNumber,
    agentId: input.agentId,
  }) === true) {
    return {
      exitCode: 1,
      stderr: `Grovie execution is already active for ${formatIssueReference(issueReference.value)} and ${input.agentId}.`,
    };
  }

  const request = input.context.localState.enqueueRunRequest?.({
    repository: input.repository,
    issueNumber: input.issueNumber,
    agentId: input.agentId,
    sourceRunId: input.sourceRunId,
    reason: input.reason,
  });

  if (request === undefined) {
    return {
      exitCode: 1,
      stderr: "Local state does not support daemon run requests.",
    };
  }

  return {
    exitCode: 0,
    stdout: [
      input.title,
      "",
      input.action,
      `Issue: ${formatIssueReference(issueReference.value)}`,
      `Agent: ${input.agentId}`,
      `Mode: ${input.mode}`,
      input.sourceRunId === undefined ? undefined : `Source run: ${input.sourceRunId}`,
      `Request: ${request.path}`,
    ].filter((line): line is string => line !== undefined).join("\n"),
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
