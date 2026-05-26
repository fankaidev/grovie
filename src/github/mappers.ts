import type {
  CreatedComment,
  GitHubCheckSummary,
  GitHubComment,
  GitHubPullRequestIssueLink,
  GitHubPullRequestReview,
  GitHubRepositoryEvent,
} from "./types.js";
import type {
  GitHubCheckRunResponse,
  GitHubCommentMutationResponse,
  GitHubCommentResponse,
  GitHubPullRequestListItemResponse,
  GitHubPullRequestReviewResponse,
  GitHubRepositoryEventResponse,
} from "./responses.js";

export function toComment(comment: GitHubCommentResponse): GitHubComment {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.user.login,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

export function toCreatedComment(comment: GitHubCommentMutationResponse): CreatedComment {
  const createdComment: CreatedComment = {
    id: comment.id,
    body: comment.body,
    url: comment.html_url,
    createdAt: comment.created_at,
  };

  if (comment.node_id !== undefined) {
    createdComment.nodeId = comment.node_id;
  }

  return createdComment;
}

export function toPullRequestReview(review: GitHubPullRequestReviewResponse): GitHubPullRequestReview {
  return {
    id: review.id,
    state: review.state,
    author: review.user.login,
    body: review.body ?? "",
    submittedAt: review.submitted_at ?? "",
  };
}

export function summarizeCheckRuns(checkRuns: GitHubCheckRunResponse[]): GitHubCheckSummary {
  const conclusionCounts: Record<string, number> = {};

  for (const checkRun of checkRuns) {
    const conclusion = checkRun.conclusion ?? "pending";
    conclusionCounts[conclusion] = (conclusionCounts[conclusion] ?? 0) + 1;
  }

  return {
    totalCount: checkRuns.length,
    conclusionCounts,
  };
}

export function normalizeMergeStateStatus(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim().toUpperCase();
}

export function toRepositoryEvent(event: GitHubRepositoryEventResponse): GitHubRepositoryEvent {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.created_at,
    actor: event.actor?.login ?? "(unknown)",
    action: event.payload?.action,
    issueNumber: event.payload?.issue?.number,
    issueUrl: event.payload?.issue?.html_url,
    pullRequestNumber: event.payload?.pull_request?.number,
    pullRequestUrl: event.payload?.pull_request?.html_url ?? undefined,
    commentUrl: event.payload?.comment?.html_url,
    reviewUrl: event.payload?.review?.html_url,
  };
}

export function isPullRequestRelatedToIssue(pullRequest: GitHubPullRequestListItemResponse, issueNumber: number): boolean {
  const issueReferencePattern = new RegExp(`(?:^|[^\\d])#${issueNumber}(?:\\D|$)`);
  const branchIssuePattern = new RegExp(`(?:^|[^A-Za-z0-9])issue-${issueNumber}(?:[^A-Za-z0-9]|$)`);
  const closingKeywordPattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
    "i",
  );

  return (
    branchIssuePattern.test(pullRequest.head.ref) ||
    issueReferencePattern.test(pullRequest.body ?? "") ||
    closingKeywordPattern.test(pullRequest.body ?? "")
  );
}

export function parsePullRequestIssueLinks(input: {
  pullRequestNumber: number;
  body: string;
  headRefName: string;
  closingIssueNumbers: number[];
}): GitHubPullRequestIssueLink[] {
  const links = new Map<number, GitHubPullRequestIssueLink>();

  for (const issueNumber of input.closingIssueNumbers) {
    links.set(issueNumber, {
      pullRequestNumber: input.pullRequestNumber,
      issueNumber,
      source: "closing-reference",
    });
  }

  for (const issueNumber of parseReferencedIssueNumbers(input.body)) {
    if (!links.has(issueNumber)) {
      links.set(issueNumber, {
        pullRequestNumber: input.pullRequestNumber,
        issueNumber,
        source: "body",
      });
    }
  }

  for (const issueNumber of parseBranchIssueNumbers(input.headRefName)) {
    if (!links.has(issueNumber)) {
      links.set(issueNumber, {
        pullRequestNumber: input.pullRequestNumber,
        issueNumber,
        source: "branch",
      });
    }
  }

  return [...links.values()].sort((left, right) => left.issueNumber - right.issueNumber);
}

function parseReferencedIssueNumbers(value: string): number[] {
  return uniqueNumbers([...value.matchAll(/(?:^|[^\d])#(?<number>[1-9]\d*)(?:\D|$)/g)]);
}

function parseBranchIssueNumbers(value: string): number[] {
  return uniqueNumbers([...value.matchAll(/(?:^|[^A-Za-z0-9])issue-(?<number>[1-9]\d*)(?:[^A-Za-z0-9]|$)/g)]);
}

function uniqueNumbers(matches: RegExpMatchArray[]): number[] {
  return [...new Set(matches
    .map((match) => match.groups?.number)
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10)))]
    .sort((left, right) => left - right);
}
