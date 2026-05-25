import { formatIssueReference } from "../github.js";
import { resolveLocalIdentity } from "../identity.js";
import { inspectQueue, renderSkippedQueueSummary, selectNextRunnableCandidate, type IssueActivity } from "../queue.js";
import { runIssueAsync } from "../run.js";
import { recordActivity } from "./activity.js";
import { runRequestedIssue, runWithLocalExecutionLock } from "./issue-execution.js";
import { isConfiguredLocalAgent } from "./locks.js";
import type { DaemonCycleResult, DaemonInput } from "./types.js";
import { NO_LOCAL_AGENTS_MESSAGE } from "./types.js";

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

  const trustedAuthors = resolveTrustedIssueAuthors(input);

  if (!trustedAuthors.ok) {
    recordActivity(input, {
      type: "queue.failed",
      message: trustedAuthors.message,
      repository: input.repository,
    });

    return {
      exitCode: 1,
      processed: false,
      stderr: trustedAuthors.message,
    };
  }

  const queueResult = inspectQueue({
    repositories: [
      {
        repository: input.repository,
        label: input.label,
        trustedAuthors: trustedAuthors.value,
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

function resolveTrustedIssueAuthors(input: Pick<DaemonInput, "config" | "github">): { ok: true; value: string[] } | { ok: false; message: string } {
  const configured = input.config.trust?.trustedAuthors.filter((author) => author.trim().length > 0) ?? [];

  if (configured.length > 0) {
    return {
      ok: true,
      value: configured,
    };
  }

  const authenticated = input.github.getAuthenticatedUser();

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

function renderActivityTriggerMessage(trigger: IssueActivity["trigger"]): string {
  if (trigger?.kind !== "pull-request-mergeability") {
    return "";
  }

  return ` because pull request #${trigger.pullRequestNumber} merge state ${trigger.mergeStateStatus} requires branch update work`;
}
