import { join } from "node:path";
import {
  createIssueClaim,
  DEFAULT_STALE_CLAIM_MS,
  renderActiveClaimMessage,
  selectActiveClaim,
  updateIssueClaim,
} from "./claim.js";
import type { GrovieConfig } from "./config.js";
import {
  formatIssueReference,
  type CreatedComment,
  type GitHubGateway,
  type GitHubIssue,
  type IssueReference,
} from "./github.js";
import { resolveLocalIdentity, type AgentMetadata } from "./identity.js";
import { buildBranchName, buildRunId, buildRunTimestamp, buildSessionId, LocalState, type DaemonLock, type ExecutionLock, type HandledCursor, type LocalStatePaths, type LockResult, type PreparedRun, type RunRequest } from "./local-state.js";
import { GitResultHandler, type HandleRunResultResult, type ResultHandler } from "./result.js";
import { CodexRuntime, type AgentRuntime, type RuntimeMonitor, type RuntimeRunResult } from "./runtime.js";
import type { SessionStatus } from "./task.js";

export type RunIssueInput = {
  issueReference: IssueReference;
  repository: string;
  config: GrovieConfig;
  configPath: string;
  agent: "codex";
  github: GitHubGateway;
  runtime?: AgentRuntime;
  localState?: RunLocalState;
  resultHandler?: ResultHandler;
  agentId?: string;
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
  registerAgent?(metadata: AgentMetadata): void;
  acquireDaemonLock?(machineId: string, now?: Date): LockResult<DaemonLock>;
  releaseDaemonLock?(lock: DaemonLock): void;
  isDaemonRunning?(machineId: string): boolean;
  acquireExecutionLock?(input: { repository: string; issueNumber: number; agentId: string; now?: Date }): LockResult<ExecutionLock>;
  hasExecutionLock?(input: { repository: string; issueNumber: number; agentId: string }): boolean;
  releaseExecutionLock?(lock: ExecutionLock): void;
  enqueueRunRequest?(input: { repository: string; issueNumber: number; agentId: string; now?: Date }): RunRequest;
  takeRunRequest?(repository: string): RunRequest | undefined;
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
  }): PreparedRun;
  appendEvent(run: PreparedRun, type: string, data?: Record<string, unknown>): void;
};

type RunSummary = {
  status: SessionStatus;
  issue: GitHubIssue;
  runId: string;
  branchName: string;
  runDir: string;
  runtime: "codex";
  agentId: string;
  machineId: string;
  result?: HandleRunResultResult;
  comment?: CreatedComment;
  error?: string;
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
    agent: input.agent,
    config: input.config,
    configPath: input.configPath,
    resultHandler: input.resultHandler,
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
        monitor: input.monitor,
      })
      : await prepared.runtime.runAsync({
        run: prepared.run,
        issue: prepared.issue,
        monitor: input.monitor,
      });

  return finishRun({
    ...prepared,
    issueReference: input.issueReference,
    github: input.github,
    agent: input.agent,
    config: input.config,
    configPath: input.configPath,
    resultHandler: input.resultHandler,
    runtimeResult,
  });
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
  const localState = input.localState ?? new LocalState();
  const runtime = input.runtime ?? new CodexRuntime();
  const now = new Date();
  const agentId = input.agentId ?? input.agent;
  const machineId = resolveSummaryMachineId(agentId);
  const sessionId = buildSessionId(repository, input.issueReference.number, agentId);
  const task = buildTaskContext({
    issue,
    configPath: input.configPath,
    agent: input.agent,
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
      error: toErrorMessage(error),
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
    runtime: input.agent,
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
  agent: "codex";
  config: GrovieConfig;
  configPath: string;
  resultHandler?: ResultHandler;
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
        runtime: input.agent,
        execution: input.runtimeResult.execution,
      });
      input.localState.appendEvent(input.run, "result.handled", {
        kind: result.kind,
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
    runtime: input.agent,
    exitCode: input.runtimeResult.execution.exitCode,
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

function buildTaskContext(input: { issue: GitHubIssue; configPath: string; agent: "codex" }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: "grovie run",
    configPath: input.configPath,
    runtime: input.agent,
    repository: `${input.issue.reference.owner}/${input.issue.reference.repo}`,
    issue: {
      number: input.issue.reference.number,
      title: input.issue.title,
      state: input.issue.state,
      labels: input.issue.labels,
      defaultBranch: input.issue.defaultBranch,
      body: input.issue.body,
      comments: input.issue.comments,
    },
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
  error: string;
}): RunSummary {
  return {
    status: "failed",
    issue: input.issue,
    runId: input.runId,
    branchName: buildBranchName(input.config.branches.prefix, input.sessionId),
    runDir: join(input.localState.getPaths().runsDir, input.runId),
    runtime: "codex",
    agentId: input.agentId,
    machineId: input.machineId,
    error: input.error,
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
    lines.push(`- Error: ${summarizeError(summary.error)}`);
  }

  if (summary.result?.kind === "no-changes") {
    lines.push("- Changes: none");
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

function summarizeError(error: string): string {
  const singleLine = error.replace(/\s+/g, " ").trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 297)}...` : singleLine;
}

function resolveSummaryMachineId(agentId: string): string {
  return agentId.includes("@") ? agentId.split("@")[1] ?? resolveLocalIdentity().machineId : resolveLocalIdentity().machineId;
}
