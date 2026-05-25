import { hasCancelRequest } from "../claim.js";
import { formatIssueReference, type IssueReference } from "../github.js";
import type { AgentMetadata } from "../identity.js";
import { getIssueActivity, type IssueActivity } from "../queue.js";
import type { RunIssueAsyncInput, RunIssueResult } from "../run.js";
import { createRuntime } from "../runtime.js";
import { recordActivity } from "./activity.js";
import { releaseExecutionLock } from "./locks.js";
import type { DaemonCycleResult, DaemonInput } from "./types.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./types.js";

export async function runRequestedIssue(input: DaemonInput & {
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

export async function runWithLocalExecutionLock(input: DaemonInput & {
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
      agentEnvKeys: agent?.envKeys,
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
