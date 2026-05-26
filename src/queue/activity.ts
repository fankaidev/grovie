import { createHash } from "node:crypto";
import type { GitHubIssue, GitHubRelatedPullRequest } from "../github.js";

export type IssueActivity = {
  timestamp: string;
  issueFingerprint: string;
  trigger?: IssueActivityTrigger;
};

export type IssueActivityTrigger = {
  kind: "pull-request-mergeability";
  pullRequestNumber: number;
  mergeStateStatus: string;
};

const GITHUB_COMMENT_UPDATE_SKEW_MS = 10_000;
const AGENT_COMMENT_MARKER = "grovie:agent-comment";

export function getIssueActivity(issue: GitHubIssue, relatedPullRequests: GitHubRelatedPullRequest[]): IssueActivity {
  const latestGrovieActivity = issue.comments
    .filter((comment) => isGrovieActivityComment(comment.body))
    .map((comment) => comment.updatedAt)
    .filter((timestamp) => !Number.isNaN(Date.parse(timestamp)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const issueUpdatedAt =
    latestGrovieActivity === undefined || isAfterGrovieCommentUpdateWindow(issue.updatedAt, latestGrovieActivity)
      ? [issue.updatedAt]
      : [];
  const timestamps = [
    ...issueUpdatedAt,
    ...issue.comments
      .filter((comment) => !isGrovieActivityComment(comment.body))
      .map((comment) => comment.updatedAt),
    ...relatedPullRequests.flatMap(getPullRequestActivityTimestamps),
  ].filter((timestamp) => !Number.isNaN(Date.parse(timestamp)));

  if (timestamps.length === 0) {
    return {
      timestamp: "1970-01-01T00:00:00.000Z",
      issueFingerprint: getIssueFingerprint(issue, relatedPullRequests),
    };
  }

  return {
    timestamp: timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "1970-01-01T00:00:00.000Z",
    issueFingerprint: getIssueFingerprint(issue, relatedPullRequests),
  };
}

export function findPullRequestMergeabilityTrigger(
  relatedPullRequests: GitHubRelatedPullRequest[],
): IssueActivityTrigger | undefined {
  const pullRequest = relatedPullRequests
    .filter((candidate) => candidate.state === "open")
    .find((candidate) => requiresBranchUpdate(candidate.mergeStateStatus));

  if (pullRequest === undefined || pullRequest.mergeStateStatus === undefined) {
    return undefined;
  }

  return {
    kind: "pull-request-mergeability",
    pullRequestNumber: pullRequest.number,
    mergeStateStatus: pullRequest.mergeStateStatus,
  };
}

export function isGrovieActivityComment(body: string): boolean {
  return body.includes("<!-- grovie:claim ") || body.includes("<!-- grovie:run ") || body.includes("<!-- grovie:session ");
}

export function readVisibleAgentCommentAgentId(body: string): string | undefined {
  const marker = new RegExp(`<!--\\s*${AGENT_COMMENT_MARKER}\\s+(?<json>\\{.*?\\})\\s*-->`).exec(body);
  const json = marker?.groups?.json;

  if (json === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(json) as { agentId?: unknown };
    return typeof parsed.agentId === "string" && parsed.agentId.length > 0 ? parsed.agentId : undefined;
  } catch {
    return undefined;
  }
}

export function isVisibleAgentCommentFor(body: string, agentId: string): boolean {
  return readVisibleAgentCommentAgentId(body) === agentId;
}

export function isOwnAgentOutputOnlyDelta(input: {
  issue: GitHubIssue;
  relatedPullRequests: GitHubRelatedPullRequest[];
  agentId: string;
  handledThrough: string;
}): boolean {
  const handledAt = Date.parse(input.handledThrough);

  if (Number.isNaN(handledAt)) {
    return false;
  }

  const recentEffectiveComments = input.issue.comments.filter((comment) =>
    !isGrovieActivityComment(comment.body) && Date.parse(comment.updatedAt) > handledAt
  );

  if (recentEffectiveComments.length === 0) {
    return false;
  }

  if (!recentEffectiveComments.every((comment) => isVisibleAgentCommentFor(comment.body, input.agentId))) {
    return false;
  }

  if (input.relatedPullRequests.flatMap(getPullRequestActivityTimestamps).some((timestamp) => Date.parse(timestamp) > handledAt)) {
    return false;
  }

  const latestOwnCommentAt = recentEffectiveComments
    .map((comment) => comment.updatedAt)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];

  return latestOwnCommentAt !== undefined && Date.parse(input.issue.updatedAt) <= Date.parse(latestOwnCommentAt);
}

function isAfterGrovieCommentUpdateWindow(issueUpdatedAt: string, latestGrovieActivity: string): boolean {
  return isAfterCommentUpdateWindow(issueUpdatedAt, latestGrovieActivity);
}

function isAfterCommentUpdateWindow(issueUpdatedAt: string, commentUpdatedAt: string): boolean {
  const issueTimestamp = Date.parse(issueUpdatedAt);
  const commentTimestamp = Date.parse(commentUpdatedAt);

  return Number.isNaN(issueTimestamp) ||
    Number.isNaN(commentTimestamp) ||
    issueTimestamp - commentTimestamp > GITHUB_COMMENT_UPDATE_SKEW_MS;
}

function getIssueFingerprint(issue: GitHubIssue, relatedPullRequests: GitHubRelatedPullRequest[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [...issue.labels].sort(),
      relatedPullRequests: relatedPullRequests.map((pullRequest) => ({
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        baseRef: pullRequest.baseRef,
        headRef: pullRequest.headRef,
        headSha: pullRequest.headSha,
        mergeStateStatus: pullRequest.mergeStateStatus,
        updatedAt: pullRequest.updatedAt,
        comments: pullRequest.comments.map((comment) => ({
          id: comment.id,
          updatedAt: comment.updatedAt,
        })),
        reviewComments: pullRequest.reviewComments.map((comment) => ({
          id: comment.id,
          updatedAt: comment.updatedAt,
        })),
        reviews: pullRequest.reviews.map((review) => ({
          id: review.id,
          state: review.state,
          submittedAt: review.submittedAt,
        })),
        checks: pullRequest.checks,
        diffSummary: pullRequest.diffSummary,
      })),
    }))
    .digest("hex");
}

function getPullRequestActivityTimestamps(pullRequest: GitHubRelatedPullRequest): string[] {
  return [
    pullRequest.updatedAt,
    ...pullRequest.comments.map((comment) => comment.updatedAt),
    ...pullRequest.reviewComments.map((comment) => comment.updatedAt),
    ...pullRequest.reviews.map((review) => review.submittedAt),
  ];
}

function requiresBranchUpdate(mergeStateStatus: string | undefined): boolean {
  const normalized = mergeStateStatus?.toUpperCase();
  return normalized === "DIRTY" || normalized === "BEHIND";
}
