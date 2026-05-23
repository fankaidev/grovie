import { createHash } from "node:crypto";
import { getAssignedAgentIds, isAssignedToLocalMachine } from "./assignment.js";
import { hasCancelRequest } from "./claim.js";
import { formatIssueReference, type GitHubGateway, type GitHubIssue, type GitHubRelatedPullRequest, type IssueReference } from "./github.js";
import type { RunLocalState } from "./run.js";

export type QueueRepositoryInput = {
  repository: string;
  label: string;
};

export type QueueCandidateStatus = "runnable" | "skipped";

export type QueueCandidate = {
  repository: string;
  issueReference: IssueReference;
  title: string;
  agentId?: string;
  status: QueueCandidateStatus;
  reason?: string;
  priority: IssuePriority;
  activity: IssueActivity;
  pickOrder?: number;
};

export type QueueInspectionResult = {
  repository: string;
  label: string;
  candidates: QueueCandidate[];
};

export type IssueActivity = {
  timestamp: string;
  issueFingerprint: string;
};

export type IssuePriority = "p0" | "p1" | "p2" | "none";

export type QueueInspectionInput = {
  repositories: QueueRepositoryInput[];
  github: GitHubGateway;
  machineId: string;
  localState?: RunLocalState;
};

const PRIORITY_RANK: Record<IssuePriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  none: 3,
};

export function inspectQueue(input: QueueInspectionInput): { ok: true; value: QueueInspectionResult[] } | { ok: false; message: string } {
  const results: QueueInspectionResult[] = [];

  for (const repository of input.repositories) {
    const listResult = input.github.listOpenIssues(repository.repository, repository.label);

    if (!listResult.ok) {
      return {
        ok: false,
        message: listResult.error.message,
      };
    }

    const candidates: QueueCandidate[] = [];

    for (const summary of listResult.value) {
      const issueResult = input.github.readIssue(summary.reference);

      if (!issueResult.ok) {
        return {
          ok: false,
          message: issueResult.error.message,
        };
      }

      const relatedPullRequestsResult = input.github.readRelatedPullRequests?.(summary.reference) ?? {
        ok: true as const,
        value: [],
      };

      if (!relatedPullRequestsResult.ok) {
        return {
          ok: false,
          message: relatedPullRequestsResult.error.message,
        };
      }

      candidates.push(...evaluateIssueCandidates({
        repository: repository.repository,
        label: repository.label,
        issue: issueResult.value,
        relatedPullRequests: relatedPullRequestsResult.value,
        machineId: input.machineId,
        localState: input.localState,
      }));
    }

    const runnable = candidates
      .filter((candidate) => candidate.status === "runnable")
      .sort(compareRunnableCandidates);

    for (const [index, candidate] of runnable.entries()) {
      candidate.pickOrder = index + 1;
    }

    results.push({
      repository: repository.repository,
      label: repository.label,
      candidates: [
        ...runnable,
        ...candidates.filter((candidate) => candidate.status === "skipped"),
      ],
    });
  }

  return {
    ok: true,
    value: results,
  };
}

export function selectNextRunnableCandidate(results: QueueInspectionResult[]): QueueCandidate | undefined {
  return results.flatMap((result) => result.candidates)
    .filter((candidate) => candidate.status === "runnable")
    .sort(compareRunnableCandidates)[0];
}

export function compareRunnableCandidates(left: Pick<QueueCandidate, "priority" | "activity" | "issueReference" | "agentId">, right: Pick<QueueCandidate, "priority" | "activity" | "issueReference" | "agentId">): number {
  return (
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
    Date.parse(left.activity.timestamp) - Date.parse(right.activity.timestamp) ||
    left.issueReference.number - right.issueReference.number ||
    (left.agentId ?? "").localeCompare(right.agentId ?? "")
  );
}

export function getIssuePriority(labels: string[]): IssuePriority {
  if (labels.includes("priority:p0")) {
    return "p0";
  }

  if (labels.includes("priority:p1")) {
    return "p1";
  }

  if (labels.includes("priority:p2")) {
    return "p2";
  }

  return "none";
}

function evaluateIssueCandidates(input: {
  repository: string;
  label: string;
  issue: GitHubIssue;
  relatedPullRequests: GitHubRelatedPullRequest[];
  machineId: string;
  localState?: RunLocalState;
}): QueueCandidate[] {
  const priority = getIssuePriority(input.issue.labels);
  const activity = getIssueActivity(input.issue, input.relatedPullRequests);
  const assignedAgentIds = getAssignedAgentIds(input.issue.labels);

  if (assignedAgentIds.length === 0) {
    return [];
  }

  if (hasCancelRequest(input.issue, input.label)) {
    return assignedAgentIds.map((agentId) => skippedCandidate(input, priority, activity, agentId, "canceled"));
  }

  if (!isAssignedToLocalMachine(input.issue.labels, input.machineId)) {
    return assignedAgentIds.map((agentId) => skippedCandidate(input, priority, activity, agentId, "assigned to another machine"));
  }

  const localAgentIds = assignedAgentIds.filter((agentId) => agentId.endsWith(`@${input.machineId}`));

  return localAgentIds.map((agentId) => {
    if (input.localState?.hasExecutionLock?.({
      repository: input.repository,
      issueNumber: input.issue.reference.number,
      agentId,
    }) === true) {
      return skippedCandidate(input, priority, activity, agentId, "active local execution lock");
    }

    const handledCursor = input.localState?.readHandledCursor?.({
      repository: input.repository,
      issueNumber: input.issue.reference.number,
      agentId,
    });

    if (handledCursor !== undefined && isHandledCursorCovered(handledCursor, activity)) {
      return skippedCandidate(input, priority, activity, agentId, "no unhandled activity");
    }

    return {
      repository: input.repository,
      issueReference: input.issue.reference,
      title: input.issue.title,
      agentId,
      status: "runnable",
      priority,
      activity,
    };
  });
}

function skippedCandidate(
  input: { repository: string; issue: GitHubIssue },
  priority: IssuePriority,
  activity: IssueActivity,
  agentId: string,
  reason: string,
): QueueCandidate {
  return {
    repository: input.repository,
    issueReference: input.issue.reference,
    title: input.issue.title,
    agentId,
    status: "skipped",
    reason,
    priority,
    activity,
  };
}

function isHandledCursorCovered(
  cursor: { handledThrough: string; issueFingerprint?: string },
  activity: IssueActivity,
): boolean {
  return (
    Date.parse(cursor.handledThrough) >= Date.parse(activity.timestamp) &&
    (cursor.issueFingerprint === undefined || cursor.issueFingerprint === activity.issueFingerprint)
  );
}

export function getIssueActivity(issue: GitHubIssue, relatedPullRequests: GitHubRelatedPullRequest[]): IssueActivity {
  const latestGrovieActivity = issue.comments
    .filter((comment) => isGrovieActivityComment(comment.body))
    .map((comment) => comment.updatedAt)
    .filter((timestamp) => !Number.isNaN(Date.parse(timestamp)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const issueUpdatedAt =
    latestGrovieActivity === undefined || Date.parse(issue.updatedAt) > Date.parse(latestGrovieActivity)
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

function isGrovieActivityComment(body: string): boolean {
  return body.includes("<!-- grovie:claim ") || body.includes("<!-- grovie:session ");
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

export function renderQueueInspection(results: QueueInspectionResult[], title = "grovie queue list"): string {
  const lines = [title, ""];

  if (results.every((result) => result.candidates.length === 0)) {
    lines.push("No assigned issues found.");
    return lines.join("\n");
  }

  for (const result of results) {
    lines.push(`${result.repository} label=${result.label}`);

    if (result.candidates.length === 0) {
      lines.push("- No assigned issues.");
      continue;
    }

    for (const candidate of result.candidates) {
      const prefix = candidate.status === "runnable" ? `#${candidate.pickOrder ?? "?"}` : "skip";
      const reason = candidate.status === "skipped" ? ` reason=${candidate.reason}` : "";
      lines.push(`- ${prefix} ${formatIssueReference(candidate.issueReference)} agent=${candidate.agentId ?? "(none)"} priority=${candidate.priority} activity=${candidate.activity.timestamp}${reason}`);
      lines.push(`  ${candidate.title}`);
    }
  }

  return lines.join("\n");
}
