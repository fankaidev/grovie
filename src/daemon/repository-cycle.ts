import type { RunIssueResult } from "../run.js";
import { resolveLocalIdentity } from "../identity.js";
import { inspectQueue, renderSkippedQueueSummary, selectRunnableCandidates } from "../queue.js";
import { runIssueAsync } from "../run.js";
import { planRepositoryEventPolling, planRepositoryEventRequest, planUnchangedRepositoryEventPolling } from "../repository-events.js";
import { recordActivity } from "./activity.js";
import { advanceSilentOwnOutputSkips, combineCycleResults, resolveTrustedIssueAuthors, runDaemonCycle, runRunnableCandidate } from "./cycle.js";
import { runResumableLocalWork } from "./resumable-runs.js";
import type { DaemonCycleResult, DaemonInput, MultiRepositoryDaemonInput } from "./types.js";
import { NO_LOCAL_AGENTS_MESSAGE } from "./types.js";

export async function runDaemonSingleRepositoryCycle(input: DaemonInput): Promise<DaemonCycleResult> {
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

export async function runDaemonRepositoryCycle(input: MultiRepositoryDaemonInput): Promise<DaemonCycleResult> {
  const now = input.now ?? (() => new Date());
  const identity = resolveLocalIdentity();
  const localAgents = input.localAgents ?? [];
  const issueRunner = input.issueRunner ?? runIssueAsync;
  const runtimeAvailability = input.runtime?.checkAvailability();
  const idleMessages: string[] = [];
  const runnableRepositories: {
    repository: string;
    label: string;
    trustedAuthors: string[];
    config: NonNullable<DaemonInput["config"]>;
    configPath: string;
    issueNumbers?: number[];
  }[] = [];
  const repositoryInputs = new Map<string, {
    label: string;
    config: NonNullable<DaemonInput["config"]>;
    configPath: string;
  }>();

  if (input.localAgents !== undefined && localAgents.length === 0) {
    return {
      exitCode: 1,
      processed: false,
      stderr: NO_LOCAL_AGENTS_MESSAGE,
    };
  }

  if (runtimeAvailability !== undefined && !runtimeAvailability.available) {
    recordActivity(input, {
      type: "runtime.unavailable",
      message: `Skipped assigned runs because ${runtimeAvailability.runtime} is unavailable: ${runtimeAvailability.message}`,
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

  for (const repository of input.repositories) {
    recordActivity(input, {
      type: "repository.poll_started",
      message: `Polling ${repository.repository}.`,
      repository: repository.repository,
      data: {
        label: repository.label,
      },
    });

    const config = repository.config ?? input.config;
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

    const resumableWorkResult = await runResumableLocalWork({
      ...input,
      repository: repository.repository,
      label: repository.label ?? config.queue.label,
      config,
      configPath: repository.configPath ?? input.configPath,
      now,
      issueRunner,
    });

    if (resumableWorkResult !== undefined) {
      if (resumableWorkResult.exitCode !== 0 || resumableWorkResult.processed) {
        return resumableWorkResult;
      }

      if (resumableWorkResult.stdout !== undefined) {
        idleMessages.push(resumableWorkResult.stdout);
      }

      continue;
    }

    const trustedAuthors = resolveTrustedIssueAuthors({
      config,
      github: input.github,
    });

    if (!trustedAuthors.ok) {
      recordActivity(input, {
        type: "queue.failed",
        message: trustedAuthors.message,
        repository: repository.repository,
      });

      return {
        exitCode: 1,
        processed: false,
        stderr: trustedAuthors.message,
      };
    }

    runnableRepositories.push({
      repository: repository.repository,
      label: repository.label ?? config.queue.label,
      trustedAuthors: trustedAuthors.value,
      config,
      configPath: repository.configPath ?? input.configPath,
      issueNumbers: eventPlan.issueNumbers,
    });
    repositoryInputs.set(repository.repository, {
      label: repository.label ?? config.queue.label,
      config,
      configPath: repository.configPath ?? input.configPath,
    });
  }

  if (runnableRepositories.length === 0) {
    return {
      exitCode: 0,
      processed: false,
      stdout: idleMessages.join("\n\n") || undefined,
    };
  }

  const queueResult = inspectQueue({
    repositories: runnableRepositories,
    github: input.github,
    machineId: identity.machineId,
    configuredAgentIds: input.localAgents?.map((agent) => agent.agentId),
    localState: input.localState,
  });

  if (!queueResult.ok) {
    recordActivity(input, {
      type: "queue.failed",
      message: queueResult.message,
    });

    return {
      exitCode: 1,
      processed: false,
      stderr: queueResult.message,
    };
  }

  advanceSilentOwnOutputSkips(input, queueResult.value, now());

  const runnableCandidates = selectRunnableCandidates(queueResult.value, input.maxConcurrentRuns ?? 3);

  if (runnableCandidates.length > 0) {
    const results = await Promise.all(runnableCandidates.map((candidate) => {
      const repositoryInput = repositoryInputs.get(candidate.repository);

      return runRunnableCandidate({
        input: {
          ...input,
          repository: candidate.repository,
          label: repositoryInput?.label ?? input.config.queue.label,
          config: repositoryInput?.config ?? input.config,
          configPath: repositoryInput?.configPath ?? input.configPath,
        },
        candidate,
        localAgents,
        now,
        issueRunner,
      });
    }));

    return combineCycleResults(results);
  }

  const skippedSummary = renderSkippedQueueSummary(queueResult.value);
  const idleQueueMessage = runnableRepositories.length === 1
    ? `No queued issues found for ${runnableRepositories[0]!.repository} with label ${runnableRepositories[0]!.label}.`
    : "No queued issues found in watched repositories.";

  return {
    exitCode: 0,
    processed: false,
    stdout: [
      ...idleMessages,
      [
        "grovie daemon",
        "",
        idleQueueMessage,
        ...(skippedSummary === undefined ? [] : ["", skippedSummary]),
      ].join("\n"),
    ].join("\n\n") || undefined,
  };
}

export function toRunIssueResult(result: DaemonCycleResult): RunIssueResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function planRepositoryCycle(input: Pick<DaemonInput, "once" | "github" | "localState" | "now">, repository: string) {
  if (input.once || input.github.listRepositoryEvents === undefined) {
    return {
      mode: "full-scan" as const,
      reason: input.once ? "one-shot daemon run uses a full scan" : "GitHub repository events are unavailable",
      eventCount: 0,
    };
  }

  const requestPlan = planRepositoryEventRequest({
    paths: input.localState?.getPaths?.(),
    repository,
    now: input.now?.(),
  });

  if (requestPlan.mode !== "request") {
    return requestPlan;
  }

  const eventsResult = input.github.listRepositoryEvents(repository, {
    ifNoneMatch: requestPlan.ifNoneMatch,
  });

  if (!eventsResult.ok) {
    return {
      mode: "full-scan" as const,
      reason: `repository events failed: ${eventsResult.error.message}`,
      eventCount: 0,
    };
  }

  if (eventsResult.value.status === "not-modified") {
    return planUnchangedRepositoryEventPolling({
      paths: input.localState?.getPaths?.(),
      repository,
      etag: eventsResult.value.etag,
      pollIntervalSeconds: eventsResult.value.pollIntervalSeconds,
      now: input.now?.(),
    });
  }

  return planRepositoryEventPolling({
    paths: input.localState?.getPaths?.(),
    repository,
    events: eventsResult.value.events,
    github: input.github,
    etag: eventsResult.value.etag,
    pollIntervalSeconds: eventsResult.value.pollIntervalSeconds,
    now: input.now?.(),
  });
}
