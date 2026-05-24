import { join } from "node:path";
import {
  createIssueClaim,
  DEFAULT_STALE_CLAIM_MS,
  renderActiveClaimMessage,
  selectActiveClaim,
  updateIssueClaim,
} from "./claim.js";
import type { GrovieConfig, RepositoryFileResult, StateRepoConfig } from "./config.js";
import {
  formatIssueReference,
  type CreatedComment,
  type GitHubGateway,
  type GitHubIssue,
  type GitHubRelatedPullRequest,
  type IssueReference,
} from "./github.js";
import { resolveLocalIdentity } from "./identity.js";
import { buildBranchName, buildRunId, buildRunTimestamp, buildSessionId, LocalState, type DaemonLock, type ExecutionLock, type HandledCursor, type LocalStatePaths, type LockResult, type PreparedRun, type ResumableRun, type RunCancellation, type RunRequest } from "./local-state.js";
import { GitResultHandler, type HandleRunResultResult, type ResultHandler } from "./result.js";
import { createRuntime, type AgentRuntime, type RuntimeMonitor, type RuntimeName, type RuntimeRunResult } from "./runtime.js";
import { syncStateRepository } from "./state-repo.js";
import type { SessionStatus } from "./task.js";

export type RunIssueInput = {
  issueReference: IssueReference;
  repository: string;
  config: GrovieConfig;
  configPath: string;
  agent: RuntimeName;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  localState?: RunLocalState;
  resultHandler?: ResultHandler;
  stateRepo?: StateRepoConfig;
  agentId?: string;
  runRequest?: {
    sourceRunId?: string;
    reason?: RunRequest["reason"];
  };
};

export type RunIssueResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  canceled?: boolean;
};

export type RunIssueAsyncInput = RunIssueInput & {
  monitor?: RuntimeMonitor;
};

export type RunClaimedIssueAsyncInput = RunIssueAsyncInput & {
  workerId?: string;
  now?: () => Date;
  staleClaimMs?: number;
};

export type RunLocalState = {
  getPaths(): LocalStatePaths;
  readRepositoryFile?(input: { repository: string; path: string }): RepositoryFileResult;
  acquireDaemonLock?(machineId: string, now?: Date): LockResult<DaemonLock>;
  releaseDaemonLock?(lock: DaemonLock): void;
  isDaemonRunning?(machineId: string): boolean;
  acquireExecutionLock?(input: { repository: string; issueNumber: number; agentId: string; now?: Date }): LockResult<ExecutionLock>;
  hasExecutionLock?(input: { repository: string; issueNumber: number; agentId: string }): boolean;
  releaseExecutionLock?(lock: ExecutionLock): void;
  enqueueRunRequest?(input: { repository: string; issueNumber: number; agentId: string; now?: Date; sourceRunId?: string; reason?: RunRequest["reason"] }): RunRequest;
  takeRunRequest?(repository: string): RunRequest | undefined;
  interruptActiveRuns?(input: { now?: Date; reason: string }): ResumableRun[];
  takeResumableRun?(input: { repository: string; now?: Date }): ResumableRun | undefined;
  markRunResuming?(input: { runId: string; now?: Date; reason: string }): void;
  markRunRejected?(input: { runId: string; now?: Date; reason: string }): void;
  requestRunCancellation?(input: { runId: string; reason?: string; now?: Date }): RunCancellation;
  isRunCancellationRequested?(runId: string): boolean;
  readHandledCursor?(input: { repository: string; issueNumber: number; agentId: string }): HandledCursor | undefined;
  writeHandledCursor?(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    handledThrough: string;
    issueFingerprint?: string;
    now?: Date;
  }): HandledCursor;
  prepareRun(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    defaultBranch: string;
    branchPrefix: string;
    now?: Date;
    prompt: string;
    task: Record<string, unknown>;
    runRequest?: RunIssueInput["runRequest"];
  }): PreparedRun;
  appendEvent(run: PreparedRun, type: string, data?: Record<string, unknown>): void;
};

type RunSummary = {
  status: SessionStatus;
  issue: GitHubIssue;
  runId: string;
  branchName: string;
  runDir: string;
  runtime: RuntimeName;
  agentId: string;
  machineId: string;
  result?: HandleRunResultResult;
  comment?: CreatedComment;
  error?: string;
  errorSource?: "prepare" | "runtime" | "result";
};

const SESSION_MARKER = "grovie:session";

export function runIssue(input: RunIssueInput): RunIssueResult {
  const prepared = prepareIssueRun(input);

  if (!prepared.ok) {
    return prepared.result;
  }

  return finishRun({
    ...prepared,
    issueReference: input.issueReference,
    github: input.github,
    config: input.config,
    configPath: input.configPath,
    resultHandler: input.resultHandler,
    stateRepo: input.stateRepo,
    runtimeResult: prepared.runtime.run({
      run: prepared.run,
      issue: prepared.issue,
    }),
  });
}

export async function runIssueAsync(input: RunIssueAsyncInput): Promise<RunIssueResult> {
  const prepared = prepareIssueRun(input);

  if (!prepared.ok) {
    return prepared.result;
  }

  const runtimeResult =
    prepared.runtime.runAsync === undefined
      ? prepared.runtime.run({
        run: prepared.run,
        issue: prepared.issue,
        monitor: mergeCancellationMonitor(prepared.localState, prepared.run, input.stateRepo, input.monitor),
      })
    : await prepared.runtime.runAsync({
        run: prepared.run,
        issue: prepared.issue,
        monitor: mergeCancellationMonitor(prepared.localState, prepared.run, input.stateRepo, input.monitor),
      });

  return finishRun({
    ...prepared,
    issueReference: input.issueReference,
    github: input.github,
    config: input.config,
    configPath: input.configPath,
    resultHandler: input.resultHandler,
    stateRepo: input.stateRepo,
    runtimeResult,
  });
}

function mergeCancellationMonitor(
  localState: RunLocalState,
  run: PreparedRun,
  stateRepo: StateRepoConfig | undefined,
  monitor: RuntimeMonitor | undefined,
): RuntimeMonitor | undefined {
  if (monitor === undefined && localState.isRunCancellationRequested === undefined && stateRepo === undefined) {
    return undefined;
  }

  return {
    heartbeatIntervalMs: monitor?.heartbeatIntervalMs,
    onHeartbeat: async (event) => {
      bestEffortStateSync({
        localState,
        stateRepo,
        run,
        agentId: run.agentId,
      });
      await monitor?.onHeartbeat?.(event);
    },
    shouldCancel: async (event) => {
      if (localState.isRunCancellationRequested?.(run.runId) === true) {
        return true;
      }

      return await monitor?.shouldCancel?.(event) === true;
    },
  };
}

export async function runClaimedIssueAsync(input: RunClaimedIssueAsyncInput): Promise<RunIssueResult> {
  const repository = `${input.issueReference.owner}/${input.issueReference.repo}`;

  if (repository !== input.repository) {
    return {
      exitCode: 1,
      stderr: `Issue repository ${repository} does not match runner repository ${input.repository}.`,
    };
  }

  const now = input.now ?? (() => new Date());
  const staleClaimMs = input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const issueResult = input.github.readIssue(input.issueReference);

  if (!issueResult.ok) {
    return {
      exitCode: 1,
      stderr: issueResult.error.message,
    };
  }

  const activeClaim = selectActiveClaim(issueResult.value, now(), staleClaimMs);

  if (activeClaim !== undefined) {
    return {
      exitCode: 1,
      stderr: renderActiveClaimMessage(input.issueReference, activeClaim),
    };
  }

  const claimResult = createIssueClaim({
    github: input.github,
    issueReference: input.issueReference,
    actor: "run",
    workerId: input.workerId ?? `grovie-run-${process.pid}`,
    now: now(),
  });

  if (!claimResult.ok) {
    return {
      exitCode: 1,
      stderr: claimResult.message,
    };
  }

  const rereadResult = input.github.readIssue(input.issueReference);

  if (!rereadResult.ok) {
    return {
      exitCode: 1,
      stderr: rereadResult.error.message,
    };
  }

  const claimOwner = selectActiveClaim(rereadResult.value, now(), staleClaimMs);

  if (claimOwner === undefined) {
    updateIssueClaim(input.github, claimResult.claim, "released", now(), "Could not confirm this task claim after creation.");

    return {
      exitCode: 1,
      stderr: `Could not confirm Grovie claim for ${formatIssueReference(input.issueReference)} after creating comment ${claimResult.claim.commentId}.`,
    };
  }

  if (claimOwner.id !== claimResult.claim.commentId) {
    updateIssueClaim(input.github, claimResult.claim, "released", now(), "Another visible task claim owns this issue.");

    return {
      exitCode: 1,
      stderr: renderActiveClaimMessage(input.issueReference, claimOwner),
    };
  }

  updateIssueClaim(input.github, claimResult.claim, "active", now());

  const result = await runIssueAsync({
    ...input,
    agentId: input.workerId ?? input.agentId,
    monitor: {
      heartbeatIntervalMs: input.monitor?.heartbeatIntervalMs,
      onHeartbeat: async (event) => {
        updateIssueClaim(input.github, claimResult.claim, "active", now());
        await input.monitor?.onHeartbeat?.(event);
      },
      shouldCancel: input.monitor?.shouldCancel,
    },
  });

  updateIssueClaim(
    input.github,
    claimResult.claim,
    "released",
    now(),
    result.canceled === true
      ? "Session canceled."
      : result.exitCode === 0
        ? "Session succeeded."
        : "Session failed. See the Grovie result comment and local run logs.",
  );

  return result;
}

type PreparedIssueRun =
  | {
    ok: true;
    issue: GitHubIssue;
    run: PreparedRun;
    localState: RunLocalState;
    runtime: AgentRuntime;
  }
  | {
    ok: false;
    result: RunIssueResult;
  };

function prepareIssueRun(input: RunIssueInput): PreparedIssueRun {
  const repository = `${input.issueReference.owner}/${input.issueReference.repo}`;

  if (repository !== input.repository) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: `Issue repository ${repository} does not match runner repository ${input.repository}.`,
      },
    };
  }

  const issueResult = input.github.readIssue(input.issueReference);

  if (!issueResult.ok) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: issueResult.error.message,
      },
    };
  }

  const issue = issueResult.value;
  const relatedPullRequestsResult = input.github.readRelatedPullRequests?.(input.issueReference) ?? {
    ok: true as const,
    value: [],
  };

  if (!relatedPullRequestsResult.ok) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: relatedPullRequestsResult.error.message,
      },
    };
  }

  const localState = input.localState ?? new LocalState();
  const runtime = input.runtime ?? createRuntime(input.config.runtime.default);
  const now = new Date();
  const agentId = input.agentId ?? input.agent;
  const machineId = resolveSummaryMachineId(agentId);
  const sessionId = buildSessionId(repository, input.issueReference.number, agentId);
  const task = buildTaskContext({
    issue,
    relatedPullRequests: relatedPullRequestsResult.value,
    configPath: input.configPath,
    runtime: runtime.name,
    runRequest: input.runRequest,
  });

  let run: PreparedRun;

  try {
    run = localState.prepareRun({
      repository,
      issueNumber: input.issueReference.number,
      agentId,
      defaultBranch: issue.defaultBranch,
      branchPrefix: input.config.branches.prefix,
      now,
      prompt: "Prompt will be generated by the selected runtime.",
      task,
      runRequest: input.runRequest,
    });
  } catch (error) {
    const summary = fallbackRunSummary({
      issue,
      config: input.config,
      localState,
      sessionId,
      runId: buildRunId(sessionId, buildRunTimestamp(now)),
      agentId,
      machineId,
      runtime: runtime.name,
      error: toErrorMessage(error),
      errorSource: "prepare",
    });
    const commentResult = input.github.createIssueComment(input.issueReference, renderRunComment(summary));

    if (!commentResult.ok) {
      return {
        ok: false,
        result: {
          exitCode: 1,
          stderr: `${summary.error}\nFailed to post result comment: ${commentResult.error.message}`,
        },
      };
    }

    return {
      ok: false,
      result: {
        exitCode: 1,
        stdout: renderCliRunOutput({ ...summary, comment: commentResult.value }),
        stderr: summary.error,
      },
    };
  }

  localState.appendEvent(run, "run.started", {
    runtime: runtime.name,
  });

  return {
    ok: true,
    issue,
    run,
    localState,
    runtime,
  };
}

function finishRun(input: {
  issue: GitHubIssue;
  run: PreparedRun;
  localState: RunLocalState;
  issueReference: IssueReference;
  github: GitHubGateway;
  config: GrovieConfig;
  configPath: string;
  resultHandler?: ResultHandler;
  stateRepo?: StateRepoConfig;
  runtimeResult: RuntimeRunResult;
}): RunIssueResult {
  let result: HandleRunResultResult | undefined;
  let resultError: string | undefined;

  if (input.runtimeResult.ok) {
    const handler = input.resultHandler ?? new GitResultHandler(input.github);

    try {
      result = handler.handle({
        run: input.run,
        issue: input.issue,
        config: input.config,
        configPath: input.configPath,
        repository: `${input.issue.reference.owner}/${input.issue.reference.repo}`,
        runtime: input.runtimeResult.execution.runtime,
        execution: input.runtimeResult.execution,
      });
      input.localState.appendEvent(input.run, "result.handled", {
        kind: result.kind,
        pullRequestUrl: result.kind === "pull-request" ? result.pullRequest.url : undefined,
      });
    } catch (error) {
      resultError = toErrorMessage(error);
      input.localState.appendEvent(input.run, "result.failed", {
        message: resultError,
      });
    }
  }

  const summary = runSummaryFromRuntimeResult({
    issue: input.issue,
    run: input.run,
    runtimeResult: input.runtimeResult,
    agentId: input.run.agentId,
    result,
    resultError,
  });

  input.localState.appendEvent(input.run, runEventType(summary.status), {
    runtime: input.runtimeResult.execution.runtime,
    exitCode: input.runtimeResult.execution.exitCode,
  });
  bestEffortStateSync({
    localState: input.localState,
    stateRepo: input.stateRepo,
    run: input.run,
    agentId: input.run.agentId,
    summary: {
      status: summary.status,
      runId: summary.runId,
      issue: formatIssueReference(summary.issue.reference),
      branchName: summary.branchName,
      runtime: summary.runtime,
      resultKind: summary.result?.kind,
    },
  });

  const commentResult = input.github.createIssueComment(input.issueReference, renderRunComment(summary));

  if (!commentResult.ok) {
    input.localState.appendEvent(input.run, "comment.failed", {
      message: commentResult.error.message,
    });

    return {
      exitCode: 1,
      stdout: renderCliRunOutput(summary),
      stderr: `Failed to post result comment: ${commentResult.error.message}`,
      canceled: summary.status === "canceled" ? true : undefined,
    };
  }

  input.localState.appendEvent(input.run, "comment.created", {
    id: commentResult.value.id,
    url: commentResult.value.url,
  });

  return {
    exitCode: summary.status === "failed" ? 1 : 0,
    stdout: renderCliRunOutput({ ...summary, comment: commentResult.value }),
    stderr: summary.error,
    canceled: summary.status === "canceled" ? true : undefined,
  };
}

function buildTaskContext(input: {
  issue: GitHubIssue;
  relatedPullRequests: GitHubRelatedPullRequest[];
  configPath: string;
  runtime: RuntimeName;
  runRequest?: RunIssueInput["runRequest"];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: "grovie run",
    configPath: input.configPath,
    runtime: input.runtime,
    repository: `${input.issue.reference.owner}/${input.issue.reference.repo}`,
    runRequest: input.runRequest,
    issue: {
      number: input.issue.reference.number,
      title: input.issue.title,
      state: input.issue.state,
      labels: input.issue.labels,
      defaultBranch: input.issue.defaultBranch,
      body: input.issue.body,
      comments: input.issue.comments,
    },
    relatedPullRequests: input.relatedPullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      url: pullRequest.url,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
      headSha: pullRequest.headSha,
      updatedAt: pullRequest.updatedAt,
      checks: pullRequest.checks,
      reviews: pullRequest.reviews,
      comments: pullRequest.comments,
      reviewComments: pullRequest.reviewComments,
      diffSummary: pullRequest.diffSummary,
    })),
  };
}

function fallbackRunSummary(input: {
  issue: GitHubIssue;
  config: GrovieConfig;
  localState: RunLocalState;
  sessionId: string;
  runId: string;
  agentId: string;
  machineId: string;
  runtime: RuntimeName;
  error: string;
  errorSource: "prepare";
}): RunSummary {
  return {
    status: "failed",
    issue: input.issue,
    runId: input.runId,
    branchName: buildBranchName(input.config.branches.prefix, input.sessionId),
    runDir: join(input.localState.getPaths().runsDir, input.runId),
    runtime: input.runtime,
    agentId: input.agentId,
    machineId: input.machineId,
    error: input.error,
    errorSource: input.errorSource,
  };
}

function runSummaryFromRuntimeResult(input: {
  issue: GitHubIssue;
  run: PreparedRun;
  runtimeResult: RuntimeRunResult;
  agentId: string;
  result?: HandleRunResultResult;
  resultError?: string;
}): RunSummary {
  const machineId = resolveSummaryMachineId(input.agentId);
  const status = input.runtimeResult.ok
    ? input.resultError === undefined
      ? "succeeded"
      : "failed"
    : input.runtimeResult.canceled === true
      ? "canceled"
      : "failed";

  return {
    status,
    issue: input.issue,
    runId: input.run.runId,
    branchName: input.run.branchName,
    runDir: input.run.runDir,
    runtime: input.runtimeResult.execution.runtime,
    agentId: input.agentId,
    machineId,
    result: input.result,
    error: input.resultError ?? (input.runtimeResult.ok ? undefined : input.runtimeResult.error.message),
    errorSource: input.resultError !== undefined ? "result" : input.runtimeResult.ok ? undefined : "runtime",
  };
}

function renderRunComment(summary: RunSummary): string {
  const marker = `<!-- ${SESSION_MARKER} ${JSON.stringify({
    runId: summary.runId,
    status: summary.status,
    runtime: summary.runtime,
  })} -->`;
  const lines = [
    marker,
    `Grovie session ${summary.status}.`,
    "",
    `- Session status: ${summary.status}`,
    `- Runtime: ${summary.runtime}`,
    `- Agent: \`${summary.agentId}\``,
    `- Machine: \`${summary.machineId}\``,
    `- Issue: ${formatIssueReference(summary.issue.reference)}`,
    `- Branch: \`${summary.branchName}\` (local; not pushed)`,
    `- Run id: \`${summary.runId}\``,
    `- Run directory: \`${summary.runDir}\``,
  ];

  if (summary.error !== undefined) {
    lines.push(`- Error: ${summarizeError(summary)}`);
  }

  if (summary.result?.kind === "no-changes") {
    lines.push("- Changes: none");

    if (isReviewerRun(summary.agentId)) {
      lines.push(`- Review output: ${summarizeOutput(summary.result.validationSummary)}`);
    }
  }

  if (summary.result?.kind === "pull-request") {
    lines.push(`- Pull request: ${summary.result.pullRequest.url}`);
  }

  return lines.join("\n");
}

function runEventType(status: SessionStatus): "run.succeeded" | "run.failed" | "run.canceled" {
  if (status === "succeeded") {
    return "run.succeeded";
  }

  return status === "canceled" ? "run.canceled" : "run.failed";
}

function renderCliRunOutput(summary: RunSummary): string {
  const lines = [
    "grovie run",
    "",
    `Session status: ${summary.status}`,
    `Issue: ${formatIssueReference(summary.issue.reference)}`,
    `Branch: ${summary.branchName}`,
    `Run id: ${summary.runId}`,
    `Run directory: ${summary.runDir}`,
  ];

  if (summary.comment !== undefined) {
    lines.push(`Comment: ${summary.comment.url}`);
  }

  if (summary.result?.kind === "no-changes") {
    lines.push("Changes: none");
  }

  if (summary.result?.kind === "pull-request") {
    lines.push(`Pull request: ${summary.result.pullRequest.url}`);
  }

  return lines.join("\n");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeError(summary: RunSummary): string {
  if (summary.errorSource === "runtime") {
    return "Runtime failed. See the local run directory for stdout and stderr.";
  }

  return summarizeOutput(summary.error ?? "Session failed.");
}

function summarizeOutput(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 297)}...` : singleLine;
}

function resolveSummaryMachineId(agentId: string): string {
  return agentId.includes("@") ? agentId.split("@")[1] ?? resolveLocalIdentity().machineId : resolveLocalIdentity().machineId;
}

function isReviewerRun(agentId: string): boolean {
  return agentId === "reviewer" || agentId.startsWith("reviewer@");
}

function bestEffortStateSync(input: {
  localState: RunLocalState;
  stateRepo: StateRepoConfig | undefined;
  run: PreparedRun;
  agentId: string;
  summary?: Record<string, unknown>;
}): void {
  if (input.stateRepo === undefined) {
    return;
  }

  const machineId = resolveSummaryMachineId(input.agentId);
  const result = syncStateRepository({
    config: input.stateRepo,
    paths: input.localState.getPaths(),
    machineId,
    agentId: input.agentId,
    run: input.run,
    summary: input.summary,
  });

  input.localState.appendEvent(input.run, result.ok ? "state_repo.synced" : "state_repo.pending", result.ok
    ? {
      committed: result.committed,
      path: result.path,
    }
    : {
      pendingPath: result.pendingPath,
      message: result.message,
    });
}
