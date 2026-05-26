import { formatIssueReference } from "../github.js";
import { resolveLocalIdentity } from "../identity.js";
import { inspectQueue, renderSkippedQueueSummary, selectNextRunnableCandidate, type IssueActivity, type QueueInspectionResult } from "../queue.js";
import { runIssueAsync } from "../run.js";
import { recordActivity } from "./activity.js";
import { runWithLocalExecutionLock } from "./issue-execution.js";
import { runResumableLocalWork } from "./resumable-runs.js";
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

  const resumableWorkResult = await runResumableLocalWork({
    ...input,
    now,
    issueRunner,
  });

  if (resumableWorkResult !== undefined) {
    return resumableWorkResult;
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

  advanceSilentOwnOutputSkips(input, queueResult.value, now());

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

function advanceSilentOwnOutputSkips(
  input: DaemonInput,
  results: QueueInspectionResult[],
  now: Date,
): void {
  for (const candidate of results.flatMap((result) => result.candidates)) {
    if (candidate.reason !== "only own agent output" || candidate.agentId === undefined) {
      continue;
    }

    input.localState?.writeHandledCursor?.({
      repository: candidate.repository,
      issueNumber: candidate.issueReference.number,
      agentId: candidate.agentId,
      handledThrough: candidate.activity.timestamp,
      issueFingerprint: candidate.activity.issueFingerprint,
      now,
    });

    recordActivity(input, {
      type: "queue.silent_skip",
      message: `${formatIssueReference(candidate.issueReference)} skipped for ${candidate.agentId}: only own agent output since last cursor.`,
      repository: candidate.repository,
      issueNumber: candidate.issueReference.number,
      agentId: candidate.agentId,
      data: {
        reason: candidate.reason,
        handledThrough: candidate.activity.timestamp,
        issueFingerprint: candidate.activity.issueFingerprint,
      },
    });
  }
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
