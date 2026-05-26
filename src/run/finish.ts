import type { GrovieConfig, StateRepoConfig } from "../config.js";
import { formatIssueReference, type GitHubGateway, type GitHubIssue, type IssueReference } from "../github.js";
import type { PreparedRun } from "../local-state.js";
import type { HandleRunResultResult, ResultHandler } from "../result.js";
import { GitResultHandler } from "../result.js";
import type { RuntimeRunResult } from "../runtime.js";
import { renderCliRunOutput, renderRunResultComment, runEventType } from "./comments.js";
import { toErrorMessage, resolveSummaryMachineId } from "./helpers.js";
import { bestEffortStateSync } from "./state-sync.js";
import type { RunIssueResult, RunLifecycleComment, RunLocalState, RunSummary } from "./types.js";

export function finishRun(input: {
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
  lifecycleComment?: RunLifecycleComment;
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
        action: result.action,
        reason: result.reason,
        pullRequestUrl: result.kind === "pull-request" ? result.pullRequest.url : undefined,
        issueCommentUrl: result.kind === "issue-comment" ? result.comment.url : undefined,
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
  const stateRepo = bestEffortStateSync({
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
      resultUrl: summary.result?.kind === "pull-request"
        ? summary.result.pullRequest.url
        : summary.result?.kind === "issue-comment"
          ? summary.result.comment.url
          : undefined,
    },
  });
  const summaryWithStateRepo = {
    ...summary,
    stateRepo,
  };

  const commentBody = renderRunResultComment(summaryWithStateRepo);
  const repository = formatIssueReference(input.issueReference).split("#")[0] ?? "";
  const commentResult = input.lifecycleComment === undefined
    ? input.github.createIssueComment(input.issueReference, commentBody)
    : input.github.updateIssueComment(repository, input.lifecycleComment.id, commentBody);

  if (!commentResult.ok) {
    input.localState.appendEvent(input.run, "comment.failed", {
      message: commentResult.error.message,
    });

    return {
      exitCode: 1,
      stdout: renderCliRunOutput(summaryWithStateRepo),
      stderr: `Failed to post result comment: ${commentResult.error.message}`,
      canceled: summary.status === "canceled" ? true : undefined,
    };
  }

  input.localState.appendEvent(input.run, input.lifecycleComment === undefined ? "comment.created" : "comment.updated", {
    id: commentResult.value.id,
    url: commentResult.value.url,
  });

  return {
    exitCode: summary.status === "failed" ? 1 : 0,
    stdout: renderCliRunOutput({ ...summaryWithStateRepo, comment: commentResult.value }),
    stderr: summary.error,
    canceled: summary.status === "canceled" ? true : undefined,
    handledThrough: summary.result?.kind === "issue-comment" ? summary.result.comment.createdAt : undefined,
    ...(isVisibleEffectiveResult(summary.result)
      ? {
        refreshes: [{
          repository,
          issueNumber: input.issueReference.number,
        }],
      }
      : {}),
  };
}

function isVisibleEffectiveResult(result: HandleRunResultResult | undefined): boolean {
  return result?.kind === "issue-comment" || result?.kind === "pull-request";
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
    startedAt: input.runtimeResult.execution.startedAt,
    endedAt: input.runtimeResult.execution.endedAt,
  };
}
