import { resolveAllowedIssueAuthors } from "../config.js";
import { formatIssueReference } from "../github.js";
import { resolveLocalIdentity } from "../identity.js";
import { inspectQueue, renderSkippedQueueSummary, selectRunnableCandidates, type IssueActivity, type QueueCandidate, type QueueInspectionResult } from "../queue.js";
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

  const runnableCandidates = selectRunnableCandidates(queueResult.value, input.maxConcurrentRuns ?? 3);

  if (runnableCandidates.length > 0) {
    const results = await Promise.all(runnableCandidates.map((candidate) =>
      runRunnableCandidate({
        input,
        candidate,
        localAgents,
        now,
        issueRunner,
      })
    ));

    return combineCycleResults(results);
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

export async function runRunnableCandidate(input: {
  input: DaemonInput;
  candidate: QueueCandidate;
  localAgents: NonNullable<DaemonInput["localAgents"]>;
  now: () => Date;
  issueRunner: NonNullable<DaemonInput["issueRunner"]>;
}): Promise<DaemonCycleResult> {
  const triggerMessage = renderActivityTriggerMessage(input.candidate.activity.trigger);
  const agentId = input.candidate.agentId ?? input.input.workerId ?? input.localAgents[0]!.agentId;

  recordActivity(input.input, {
    type: "queue.runnable_found",
    message: `Selected ${formatIssueReference(input.candidate.issueReference)} for ${agentId}${triggerMessage}.`,
    repository: input.input.repository,
    issueNumber: input.candidate.issueReference.number,
    agentId,
    data: {
      priority: input.candidate.priority,
      activityTimestamp: input.candidate.activity.timestamp,
      issueFingerprint: input.candidate.activity.issueFingerprint,
      trigger: input.candidate.activity.trigger,
    },
  });

  return runWithLocalExecutionLock({
    ...input.input,
    issueReference: input.candidate.issueReference,
    workerId: agentId,
    issueActivity: input.candidate.activity,
    triggerContext: {
      source: "daemon",
      activity: input.candidate.activity,
    },
    now: input.now,
    issueRunner: input.issueRunner,
  });
}

export function combineCycleResults(results: DaemonCycleResult[]): DaemonCycleResult {
  if (results.length === 1) {
    return results[0]!;
  }

  const failed = results.find((result) => result.exitCode !== 0);
  const stdout = results.map((result) => result.stdout).filter((value) => value !== undefined && value.length > 0).join("\n\n");
  const stderr = results.map((result) => result.stderr).filter((value) => value !== undefined && value.length > 0).join("\n\n");
  const refreshes = dedupeRefreshes(results.flatMap((result) => result.refreshes ?? []));

  return {
    exitCode: failed?.exitCode ?? 0,
    processed: results.some((result) => result.processed),
    ...(stdout.length === 0 ? {} : { stdout }),
    ...(stderr.length === 0 ? {} : { stderr }),
    ...(refreshes.length === 0 ? {} : { refreshes }),
  };
}

function dedupeRefreshes(refreshes: NonNullable<DaemonCycleResult["refreshes"]>): NonNullable<DaemonCycleResult["refreshes"]> {
  const seen = new Set<string>();
  const deduped: NonNullable<DaemonCycleResult["refreshes"]> = [];

  for (const refresh of refreshes) {
    const key = `${refresh.repository}#${refresh.issueNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(refresh);
  }

  return deduped;
}

export function advanceSilentOwnOutputSkips(
  input: Pick<DaemonInput, "localState" | "now">,
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

export function resolveTrustedIssueAuthors(input: Pick<DaemonInput, "config" | "github">): { ok: true; value: string[] | undefined } | { ok: false; message: string } {
  return resolveAllowedIssueAuthors(input.config);
}

function renderActivityTriggerMessage(trigger: IssueActivity["trigger"]): string {
  if (trigger?.kind !== "pull-request-mergeability") {
    return "";
  }

  return ` because pull request #${trigger.pullRequestNumber} merge state ${trigger.mergeStateStatus} requires branch update work`;
}
