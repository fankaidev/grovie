import type { GrovieConfig, LoadedConfig, StateRepoConfig } from "./config.js";
import {
  createAdminConsoleServer,
  resolveAdminConsoleConfig,
  startAdminConsoleServer,
  startAdminConsoleWorker,
  type AdminConsoleResolvedConfig,
  type StartedAdminConsole,
} from "./admin-console.js";
import { appendDaemonActivity } from "./daemon-activity.js";
import {
  hasCancelRequest,
} from "./claim.js";
import {
  formatIssueReference,
  type GitHubGateway,
  type IssueReference,
} from "./github.js";
import { type AgentMetadata, resolveLocalIdentity } from "./identity.js";
import type { DaemonLock, ExecutionLock } from "./local-state.js";
import { getIssueActivity, inspectQueue, renderSkippedQueueSummary, selectNextRunnableCandidate, type IssueActivity } from "./queue.js";
import type { RunIssueAsyncInput, RunIssueResult, RunLocalState } from "./run.js";
import { runIssueAsync } from "./run.js";
import type { AgentRuntime } from "./runtime.js";
import { createRuntime } from "./runtime.js";
import { LocalDaemonLifecycle, type DaemonLifecycle } from "./daemon-lifecycle.js";
import { planRepositoryEventPolling } from "./repository-events.js";

export type DaemonInput = {
  repository: string;
  label: string;
  config: GrovieConfig;
  configPath: string;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  localState?: RunLocalState;
  stateRepo?: StateRepoConfig;
  localAgents?: AgentMetadata[];
  once: boolean;
  workerId?: string;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => void | Promise<void>;
  onCycleResult?: (result: RunIssueResult) => void | Promise<void>;
  issueRunner?: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
  adminConsole?: AdminConsoleResolvedConfig;
  daemonLifecycle?: DaemonLifecycle;
  issueNumbers?: number[];
};

export type DaemonRepositoryInput = {
  repository: string;
  label?: string;
  config?: GrovieConfig;
  configPath?: string;
};

export type MultiRepositoryDaemonInput = Omit<DaemonInput, "repository" | "label"> & {
  repositories: DaemonRepositoryInput[];
  repositoryConfigLoader?: (repository: string) => LoadedConfig;
};

type DaemonCycleResult = RunIssueResult & {
  processed: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const NO_LOCAL_AGENTS_MESSAGE = "No local agents are configured. Add agents to the global Grovie config before starting the daemon.";

export async function runDaemon(input: DaemonInput): Promise<RunIssueResult> {
  const localAgentError = validateLocalAgents(input);

  if (localAgentError !== undefined) {
    return localAgentError;
  }

  const daemonLockResult = acquireDaemonLock(input);

  if (!daemonLockResult.ok) {
    return {
      exitCode: 1,
      stderr: daemonLockResult.message,
    };
  }

  let adminConsole: StartedAdminConsole | undefined;

  try {
    adminConsole = await startDaemonAdminConsole(input);
  } catch (error) {
    releaseDaemonLock(input, daemonLockResult.lock);

    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (input.once) {
      return toRunIssueResult(await runDaemonCycle(input));
    }

    while (true) {
      const result = await runDaemonSingleRepositoryCycle(input);
      await reportDaemonCycle(input, result);
      const sleep = input.sleep ?? sleepSync;
      await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    await stopDaemonAdminConsole(adminConsole);
    releaseDaemonLock(input, daemonLockResult.lock);
  }
}

async function runDaemonSingleRepositoryCycle(input: DaemonInput): Promise<DaemonCycleResult> {
  recordActivity(input, {
    type: "repository.poll_started",
    message: `Polling ${input.repository}.`,
    repository: input.repository,
    data: {
      label: input.label,
    },
  });

  const eventPlan = planRepositoryCycle(input, input.repository);

  recordActivity(input, {
    type: `repository.events_${eventPlan.mode}`,
    message: `${input.repository}: ${eventPlan.reason}.`,
    repository: input.repository,
    data: {
      eventCount: eventPlan.eventCount,
      issueNumbers: eventPlan.issueNumbers,
    },
  });

  if (eventPlan.mode === "skip") {
    return {
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        `Skipped ${input.repository}: ${eventPlan.reason}.`,
      ].join("\n"),
    };
  }

  return runDaemonCycle({
    ...input,
    issueNumbers: eventPlan.issueNumbers,
  });
}

export async function runDaemonForRepositories(input: MultiRepositoryDaemonInput): Promise<RunIssueResult> {
  const localAgentError = validateLocalAgents(input);

  if (localAgentError !== undefined) {
    return localAgentError;
  }

  const daemonLockResult = acquireDaemonLock(input);

  if (!daemonLockResult.ok) {
    return {
      exitCode: 1,
      stderr: daemonLockResult.message,
    };
  }

  if (input.repositories.length === 0) {
    releaseDaemonLock(input, daemonLockResult.lock);

    return {
      exitCode: 1,
      stderr: "No watched repositories configured. Add one with `grovie watch add owner/repo`.",
    };
  }

  let adminConsole: StartedAdminConsole | undefined;

  try {
    adminConsole = await startDaemonAdminConsole(input);
  } catch (error) {
    releaseDaemonLock(input, daemonLockResult.lock);

    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (!input.once) {
      while (true) {
        const result = await runDaemonRepositoryCycle(input);
        await reportDaemonCycle(input, result);
        const sleep = input.sleep ?? sleepSync;
        await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      }
    }

    return toRunIssueResult(await runDaemonRepositoryCycle(input));
  } finally {
    await stopDaemonAdminConsole(adminConsole);
    releaseDaemonLock(input, daemonLockResult.lock);
  }
}

async function startDaemonAdminConsole(input: MultiRepositoryDaemonInput | DaemonInput): Promise<StartedAdminConsole | undefined> {
  const config = input.adminConsole ?? resolveAdminConsoleConfig({
    version: 1,
    agents: [],
    watchedRepositories: [],
    adminConsole: {
      enabled: false,
    },
  });

  if (!config.enabled) {
    return undefined;
  }

  if (input.localState === undefined) {
    throw new Error("Admin console requires local daemon state.");
  }

  const daemonLifecycle = input.daemonLifecycle ?? new LocalDaemonLifecycle();

  if (!input.once) {
    return startAdminConsoleWorker({
      config,
      paths: input.localState.getPaths(),
    });
  }

  return startAdminConsoleServer({
    config,
    server: createAdminConsoleServer({
      paths: input.localState.getPaths(),
      daemonLifecycle,
    }),
  });
}

async function stopDaemonAdminConsole(started: StartedAdminConsole | undefined): Promise<void> {
  if (started === undefined) {
    return;
  }

  started.server.closeAllConnections();

  await new Promise<void>((resolve, reject) => {
    started.server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

async function runDaemonRepositoryCycle(input: MultiRepositoryDaemonInput): Promise<DaemonCycleResult> {
  const idleMessages: string[] = [];
  const policyErrors: string[] = [];

  for (const repository of input.repositories) {
    recordActivity(input, {
      type: "repository.poll_started",
      message: `Polling ${repository.repository}.`,
      repository: repository.repository,
      data: {
        label: repository.label,
      },
    });

    let loadedConfig: LoadedConfig | undefined;

    try {
      loadedConfig = input.repositoryConfigLoader?.(repository.repository);
    } catch (error) {
      recordActivity(input, {
        type: "repository.policy_failed",
        message: `Skipped ${repository.repository}: ${toErrorMessage(error)}`,
        repository: repository.repository,
      });
      policyErrors.push(`Skipped ${repository.repository}: ${toErrorMessage(error)}`);
      continue;
    }

    const config = loadedConfig?.config ?? repository.config ?? input.config;
    const eventPlan = planRepositoryCycle(input, repository.repository);

    recordActivity(input, {
      type: `repository.events_${eventPlan.mode}`,
      message: `${repository.repository}: ${eventPlan.reason}.`,
      repository: repository.repository,
      data: {
        eventCount: eventPlan.eventCount,
        issueNumbers: eventPlan.issueNumbers,
      },
    });

    if (eventPlan.mode === "skip") {
      idleMessages.push([
        "grovie daemon",
        "",
        `Skipped ${repository.repository}: ${eventPlan.reason}.`,
      ].join("\n"));
      continue;
    }

    const result = await runDaemonCycle({
      ...input,
      repository: repository.repository,
      label: repository.label ?? config.queue.label,
      config,
      configPath: loadedConfig?.path ?? repository.configPath ?? input.configPath,
      issueNumbers: eventPlan.issueNumbers,
    });

    if (result.exitCode !== 0 || result.processed) {
      return {
        ...result,
        stderr: renderPolicyErrorOutput(policyErrors, result.stderr),
      };
    }

    if (result.stdout !== undefined) {
      idleMessages.push(result.stdout);
    }
  }

  return {
    exitCode: policyErrors.length > 0 ? 1 : 0,
    processed: false,
    stdout: idleMessages.join("\n\n") || undefined,
    stderr: renderPolicyErrorOutput(policyErrors),
  };
}

function toRunIssueResult(result: DaemonCycleResult): RunIssueResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runDaemonCycle(input: DaemonInput): Promise<DaemonCycleResult> {
  const now = input.now ?? (() => new Date());
  const identity = resolveLocalIdentity();
  const localAgents = input.localAgents ?? [];

  recordActivity(input, {
    type: "cycle.started",
    message: `Checking ${input.repository} for label ${input.label}.`,
    repository: input.repository,
    data: {
      label: input.label,
      localAgents: localAgents.map((agent) => agent.agentId),
    },
  });

  if (input.localAgents !== undefined && localAgents.length === 0) {
    return {
      exitCode: 1,
      processed: false,
      stderr: NO_LOCAL_AGENTS_MESSAGE,
    };
  }

  const issueRunner = input.issueRunner ?? runIssueAsync;
  const runtimeAvailability = input.runtime?.checkAvailability();

  if (runtimeAvailability !== undefined && !runtimeAvailability.available) {
    recordActivity(input, {
      type: "runtime.unavailable",
      message: `Skipped assigned runs because ${runtimeAvailability.runtime} is unavailable: ${runtimeAvailability.message}`,
      repository: input.repository,
    });

    return {
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        `Skipped assigned runs because Codex runtime is unavailable: ${runtimeAvailability.message}`,
      ].join("\n"),
    };
  }

  const resumableRun = input.localState?.takeResumableRun?.({
    repository: input.repository,
    now: now(),
  });

  if (resumableRun !== undefined) {
    recordActivity(input, {
      type: "run.resume_detected",
      message: `Found resumable run ${resumableRun.runId} for ${input.repository}#${resumableRun.issueNumber}.`,
      repository: input.repository,
      issueNumber: resumableRun.issueNumber,
      agentId: resumableRun.agentId,
      data: {
        runId: resumableRun.runId,
        status: resumableRun.status,
      },
    });

    if (!isConfiguredLocalAgent(input, resumableRun.agentId)) {
      const reason = `Agent ${resumableRun.agentId} is not configured locally.`;
      input.localState?.markRunRejected?.({
        runId: resumableRun.runId,
        now: now(),
        reason,
      });

      recordActivity(input, {
        type: "run.resume_rejected",
        message: `Rejected resumable run ${resumableRun.runId}: ${reason}`,
        repository: input.repository,
        issueNumber: resumableRun.issueNumber,
        agentId: resumableRun.agentId,
        data: {
          runId: resumableRun.runId,
        },
      });

      return {
        exitCode: 0,
        processed: true,
        stdout: [
          "grovie daemon",
          "",
          `Skipped resumable run ${resumableRun.runId} for ${input.repository}#${resumableRun.issueNumber}: ${reason}`,
        ].join("\n"),
      };
    }

    const result = await runRequestedIssue({
      ...input,
      issueNumber: resumableRun.issueNumber,
      workerId: resumableRun.agentId,
      runRequest: {
        sourceRunId: resumableRun.runId,
        reason: "resume",
      },
      now,
      issueRunner,
    });

    if (result.processed) {
      input.localState?.markSessionResuming?.({
        sourceRunId: resumableRun.runId,
        now: now(),
        reason: "daemon restart recovery",
      });
    }

    return result;
  }

  const request = input.localState?.takeRunRequest?.(input.repository);

  if (request !== undefined) {
    recordActivity(input, {
      type: "run.request_received",
      message: `Received ${request.reason ?? "manual"} run request ${request.id} for ${input.repository}#${request.issueNumber}.`,
      repository: input.repository,
      issueNumber: request.issueNumber,
      agentId: request.agentId,
      data: {
        requestId: request.id,
        reason: request.reason,
        sourceRunId: request.sourceRunId,
      },
    });

    if (!isConfiguredLocalAgent(input, request.agentId)) {
      const reason = `Agent ${request.agentId} is not configured locally.`;

      if (request.sourceRunId !== undefined) {
        input.localState?.markRunRejected?.({
          runId: request.sourceRunId,
          now: now(),
          reason,
        });
      }

      recordActivity(input, {
        type: "run.request_rejected",
        message: `Rejected run request ${request.id}: ${reason}`,
        repository: input.repository,
        issueNumber: request.issueNumber,
        agentId: request.agentId,
        data: {
          requestId: request.id,
        },
      });

      return {
        exitCode: 0,
        processed: true,
        stdout: [
          "grovie daemon",
          "",
          `Rejected run request ${request.id} for ${input.repository}#${request.issueNumber}: ${reason}`,
        ].join("\n"),
      };
    }

    return runRequestedIssue({
      ...input,
      issueNumber: request.issueNumber,
      workerId: request.agentId,
      runRequest: {
        sourceRunId: request.sourceRunId,
        reason: request.reason,
      },
      now,
      issueRunner,
    });
  }

  const queueResult = inspectQueue({
    repositories: [
      {
        repository: input.repository,
        label: input.label,
      },
    ],
    github: input.github,
    machineId: identity.machineId,
    configuredAgentIds: input.localAgents?.map((agent) => agent.agentId),
    localState: input.localState,
    issueNumbers: input.issueNumbers,
  });

  if (!queueResult.ok) {
    recordActivity(input, {
      type: "queue.failed",
      message: queueResult.message,
      repository: input.repository,
    });

    return {
      exitCode: 1,
      processed: false,
      stderr: queueResult.message,
    };
  }

  const candidate = selectNextRunnableCandidate(queueResult.value);

  if (candidate !== undefined) {
    const triggerMessage = renderActivityTriggerMessage(candidate.activity.trigger);

    recordActivity(input, {
      type: "queue.runnable_found",
      message: `Selected ${formatIssueReference(candidate.issueReference)} for ${candidate.agentId ?? input.workerId ?? localAgents[0]!.agentId}${triggerMessage}.`,
      repository: input.repository,
      issueNumber: candidate.issueReference.number,
      agentId: candidate.agentId ?? input.workerId ?? localAgents[0]!.agentId,
      data: {
        priority: candidate.priority,
        activityTimestamp: candidate.activity.timestamp,
        issueFingerprint: candidate.activity.issueFingerprint,
        trigger: candidate.activity.trigger,
      },
    });

    return runWithLocalExecutionLock({
      ...input,
      issueReference: candidate.issueReference,
      workerId: candidate.agentId ?? input.workerId ?? localAgents[0]!.agentId,
      issueActivity: candidate.activity,
      triggerContext: {
        source: "daemon",
        activity: candidate.activity,
      },
      now,
      issueRunner,
    });
  }

  const skippedSummary = renderSkippedQueueSummary(queueResult.value);

  recordActivity(input, {
    type: "queue.idle",
    message: `No queued issues found for ${input.repository} with label ${input.label}.`,
    repository: input.repository,
    data: {
      skippedSummary,
    },
  });

  return {
    exitCode: 0,
    processed: false,
    stdout: [
      "grovie daemon",
      "",
      `No queued issues found for ${input.repository} with label ${input.label}.`,
      ...(skippedSummary === undefined ? [] : ["", skippedSummary]),
    ].join("\n"),
  };
}

function renderActivityTriggerMessage(trigger: IssueActivity["trigger"]): string {
  if (trigger?.kind !== "pull-request-mergeability") {
    return "";
  }

  return ` because pull request #${trigger.pullRequestNumber} merge state ${trigger.mergeStateStatus} requires branch update work`;
}

function planRepositoryCycle(input: Pick<DaemonInput, "once" | "github" | "localState" | "now">, repository: string) {
  if (input.once || input.github.listRepositoryEvents === undefined) {
    return {
      mode: "full-scan" as const,
      reason: input.once ? "one-shot daemon run uses a full scan" : "GitHub repository events are unavailable",
      eventCount: 0,
    };
  }

  const eventsResult = input.github.listRepositoryEvents(repository);

  if (!eventsResult.ok) {
    return {
      mode: "full-scan" as const,
      reason: `repository events failed: ${eventsResult.error.message}`,
      eventCount: 0,
    };
  }

  return planRepositoryEventPolling({
    paths: input.localState?.getPaths?.(),
    repository,
    events: eventsResult.value,
    github: input.github,
    now: input.now?.(),
  });
}

async function runRequestedIssue(input: DaemonInput & {
  issueNumber: number;
  workerId: string;
  runRequest: RunIssueAsyncInput["runRequest"];
  now: () => Date;
  issueRunner: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
}): Promise<DaemonCycleResult> {
  const [owner, repo] = input.repository.split("/");
  const issueReference = {
    owner: owner ?? "",
    repo: repo ?? "",
    number: input.issueNumber,
  };
  const issueResult = input.github.readIssue(issueReference);

  if (!issueResult.ok) {
    recordActivity(input, {
      type: "issue.read_failed",
      message: issueResult.error.message,
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.workerId,
    });

    return {
      exitCode: 1,
      processed: false,
      stderr: issueResult.error.message,
    };
  }

  const relatedPullRequestsResult = input.github.readRelatedPullRequests?.(issueReference) ?? {
    ok: true as const,
    value: [],
  };

  if (!relatedPullRequestsResult.ok) {
    recordActivity(input, {
      type: "pull_requests.read_failed",
      message: relatedPullRequestsResult.error.message,
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.workerId,
    });

    return {
      exitCode: 1,
      processed: false,
      stderr: relatedPullRequestsResult.error.message,
    };
  }

  return runWithLocalExecutionLock({
    ...input,
    issueReference,
    issueActivity: getIssueActivity(issueResult.value, relatedPullRequestsResult.value),
  });
}

async function runWithLocalExecutionLock(input: DaemonInput & {
  issueReference: IssueReference;
  workerId: string;
  issueActivity: IssueActivity;
  triggerContext?: RunIssueAsyncInput["triggerContext"];
  runRequest?: RunIssueAsyncInput["runRequest"];
  now: () => Date;
  issueRunner: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
}): Promise<DaemonCycleResult> {
  const executionLockResult = input.localState?.acquireExecutionLock?.({
    repository: input.repository,
    issueNumber: input.issueReference.number,
    agentId: input.workerId,
    now: input.now(),
  });

  if (executionLockResult !== undefined && !executionLockResult.ok) {
    recordActivity(input, {
      type: "run.lock_skipped",
      message: `Skipped ${formatIssueReference(input.issueReference)} because local execution is already active for ${input.workerId}.`,
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
    });

    return {
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        `Skipped ${formatIssueReference(input.issueReference)} because local execution is already active for ${input.workerId}.`,
      ].join("\n"),
    };
  }

  const rereadResult = input.github.readIssue(input.issueReference);

  if (!rereadResult.ok) {
    releaseExecutionLock(input, executionLockResult?.lock);

    recordActivity(input, {
      type: "issue.reread_failed",
      message: rereadResult.error.message,
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
    });

    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: rereadResult.error.message,
    });
  }

  const rereadIssue = rereadResult.value;

  if (hasCancelRequest(rereadIssue, input.label)) {
    releaseExecutionLock(input, executionLockResult?.lock);

    recordActivity(input, {
      type: "run.canceled_before_start",
      message: `Canceled ${formatIssueReference(input.issueReference)} before runtime start.`,
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
    });

    return Promise.resolve({
      exitCode: 0,
      processed: true,
      stdout: [
        "grovie daemon",
        "",
        `Canceled ${formatIssueReference(input.issueReference)} before runtime start.`,
      ].join("\n"),
    });
  }

  try {
    recordActivity(input, {
      type: "run.started",
      message: `Starting ${formatIssueReference(input.issueReference)} for ${input.workerId}.`,
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
      data: {
        reason: input.runRequest?.reason,
        sourceRunId: input.runRequest?.sourceRunId,
      },
    });

    const agent = resolveWorkerAgent(input, input.workerId);
    const runtimeName = agent?.runtime ?? "codex";
    const result = await input.issueRunner({
      issueReference: input.issueReference,
      repository: input.repository,
      config: input.config,
      configPath: input.configPath,
      agent: runtimeName,
      agentId: input.workerId,
      agentInstructions: agent?.instructions,
      github: input.github,
      runtime: input.runtime ?? createRuntime(runtimeName),
      localState: input.localState,
      runRequest: input.runRequest,
      triggerContext: input.triggerContext,
      stateRepo: input.stateRepo,
      monitor: {
        heartbeatIntervalMs: input.stateRepo?.syncIntervalSeconds === undefined
          ? input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
          : input.stateRepo.syncIntervalSeconds * 1000,
        onHeartbeat: () => undefined,
        shouldCancel: () => {
          const latestIssue = input.github.readIssue(input.issueReference);

          if (!latestIssue.ok) {
            return false;
          }

          return hasCancelRequest(latestIssue.value, input.label);
        },
      },
    });

    const postRunPullRequestActivityTimestamp = readPostRunPullRequestActivityTimestamp(input);
    const handledThrough = maxTimestamp(
      maxTimestamp(input.issueActivity.timestamp, result.handledThrough),
      postRunPullRequestActivityTimestamp,
    );

    input.localState?.writeHandledCursor?.({
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
      handledThrough,
      issueFingerprint: handledThrough === input.issueActivity.timestamp ? input.issueActivity.issueFingerprint : undefined,
      now: input.now(),
    });

    recordActivity(input, {
      type: result.exitCode === 0 ? "run.completed" : "run.failed",
      message: `${formatIssueReference(input.issueReference)} finished for ${input.workerId} with exit code ${result.exitCode}.`,
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
      data: {
        exitCode: result.exitCode,
        handledThrough,
      },
    });

    return {
      ...result,
      processed: true,
    };
  } finally {
    releaseExecutionLock(input, executionLockResult?.lock);
  }
}

function resolveWorkerAgent(input: Pick<DaemonInput, "localAgents">, agentId: string): AgentMetadata | undefined {
  return input.localAgents?.find((candidate) => candidate.agentId === agentId);
}

function recordActivity(
  input: Pick<DaemonInput, "localState" | "now">,
  entry: Parameters<typeof appendDaemonActivity>[1],
): void {
  appendDaemonActivity(input.localState?.getPaths?.(), {
    ...entry,
    timestamp: entry.timestamp ?? (input.now?.() ?? new Date()).toISOString(),
  });
}

function readPostRunPullRequestActivityTimestamp(input: Pick<DaemonInput, "github"> & {
  issueReference: IssueReference;
}): string | undefined {
  const relatedPullRequestsResult = input.github.readRelatedPullRequests?.(input.issueReference) ?? {
    ok: true as const,
    value: [],
  };

  if (!relatedPullRequestsResult.ok) {
    return undefined;
  }

  return relatedPullRequestsResult.value
    .flatMap((pullRequest) => [
      pullRequest.updatedAt,
      ...pullRequest.comments.map((comment) => comment.updatedAt),
      ...pullRequest.reviewComments.map((comment) => comment.updatedAt),
      ...pullRequest.reviews.map((review) => review.submittedAt),
    ])
    .filter((timestamp) => !Number.isNaN(Date.parse(timestamp)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function maxTimestamp(left: string, right: string | undefined): string {
  if (right === undefined || Number.isNaN(Date.parse(right))) {
    return left;
  }

  if (Number.isNaN(Date.parse(left)) || Date.parse(right) > Date.parse(left)) {
    return right;
  }

  return left;
}

function acquireDaemonLock(input: Pick<DaemonInput, "localState" | "now">) {
  const identity = resolveLocalIdentity();
  return input.localState?.acquireDaemonLock?.(identity.machineId, input.now?.() ?? new Date()) ?? {
    ok: true as const,
    lock: undefined,
  };
}

function validateLocalAgents(input: Pick<DaemonInput, "localAgents">): RunIssueResult | undefined {
  if (input.localAgents !== undefined && input.localAgents.length === 0) {
    return {
      exitCode: 1,
      stderr: NO_LOCAL_AGENTS_MESSAGE,
    };
  }

  return undefined;
}

function isConfiguredLocalAgent(input: Pick<DaemonInput, "localAgents">, agentId: string): boolean {
  return input.localAgents === undefined || input.localAgents.some((agent) => agent.agentId === agentId);
}

function releaseDaemonLock(input: Pick<DaemonInput, "localState">, lock: DaemonLock | undefined): void {
  if (lock !== undefined) {
    input.localState?.releaseDaemonLock?.(lock);
  }
}

function releaseExecutionLock(input: Pick<DaemonInput, "localState">, lock: ExecutionLock | undefined): void {
  if (lock !== undefined) {
    input.localState?.releaseExecutionLock?.(lock);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderPolicyErrorOutput(policyErrors: string[], existingStderr?: string): string | undefined {
  const policyStderr = policyErrors.length > 0
    ? [
      "grovie daemon",
      "",
      ...policyErrors,
    ].join("\n")
    : undefined;

  return [policyStderr, existingStderr]
    .filter((output): output is string => output !== undefined && output.length > 0)
    .join("\n\n") || undefined;
}

async function reportDaemonCycle(input: Pick<DaemonInput, "onCycleResult">, result: RunIssueResult): Promise<void> {
  if (input.onCycleResult !== undefined) {
    await input.onCycleResult(result);
    return;
  }

  if (result.stderr !== undefined && result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
}

function sleepSync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
