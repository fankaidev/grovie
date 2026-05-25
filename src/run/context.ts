import type { GitHubIssue, GitHubRelatedPullRequest } from "../github.js";
import { getIssueActivity } from "../queue.js";
import type { RuntimeName } from "../runtime.js";
import type { RunIssueInput, RunLocalState, RunTriggerContext } from "./types.js";

export function buildTaskContext(input: {
  issue: GitHubIssue;
  relatedPullRequests: GitHubRelatedPullRequest[];
  configPath: string;
  runtime: RuntimeName;
  agentInstructions?: string;
  runRequest?: RunIssueInput["runRequest"];
  triggerContext: RunTriggerContext;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: "grovie run",
    configPath: input.configPath,
    runtime: input.runtime,
    agentInstructions: input.agentInstructions,
    repository: `${input.issue.reference.owner}/${input.issue.reference.repo}`,
    runRequest: input.runRequest,
    trigger: {
      source: input.triggerContext.source,
      activity: {
        timestamp: input.triggerContext.activity.timestamp,
        issueFingerprint: input.triggerContext.activity.issueFingerprint,
      },
      previousHandledCursor: input.triggerContext.previousHandledCursor,
      daemonTrigger: input.triggerContext.source === "daemon"
        ? input.triggerContext.activity.trigger
        : undefined,
    },
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
      mergeStateStatus: pullRequest.mergeStateStatus,
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

export function resolveTriggerContext(input: {
  input: RunIssueInput;
  localState: RunLocalState;
  agentId: string;
  issue: GitHubIssue;
  relatedPullRequests: GitHubRelatedPullRequest[];
  repository: string;
}): RunTriggerContext {
  const previousHandledCursor = input.input.triggerContext?.previousHandledCursor
    ?? input.localState.readHandledCursor?.({
      repository: input.repository,
      issueNumber: input.issue.reference.number,
      agentId: input.agentId,
    });

  return {
    source: input.input.triggerContext?.source
      ?? (input.input.runRequest === undefined ? "manual" : "run-request"),
    activity: input.input.triggerContext?.activity
      ?? getIssueActivity(input.issue, input.relatedPullRequests),
    previousHandledCursor,
  };
}
