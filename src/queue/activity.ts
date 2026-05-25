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

function isGrovieActivityComment(body: string): boolean {
  return body.includes("<!-- grovie:claim ") || body.includes("<!-- grovie:run ") || body.includes("<!-- grovie:session ");
}

function isAfterGrovieCommentUpdateWindow(issueUpdatedAt: string, latestGrovieActivity: string): boolean {
  const issueTimestamp = Date.parse(issueUpdatedAt);
  const grovieTimestamp = Date.parse(latestGrovieActivity);

  return Number.isNaN(issueTimestamp) ||
    Number.isNaN(grovieTimestamp) ||
    issueTimestamp - grovieTimestamp > GITHUB_COMMENT_UPDATE_SKEW_MS;
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
