import { getAssignedAgentIds, isAssignedToLocalMachine } from "../assignment.js";
import { hasCancelRequest } from "../claim.js";
import type { GitHubIssue, GitHubRelatedPullRequest } from "../github.js";
import type { RunLocalState } from "../run.js";
import {
  findPullRequestMergeabilityTrigger,
  getIssueActivity,
  isOwnAgentOutputOnlyDelta,
  type IssueActivity,
} from "./activity.js";
import type { IssuePriority, QueueCandidate } from "../queue.js";

type IssueSkipCheck = {
  skipped: true;
  candidates: QueueCandidate[];
} | {
  skipped: false;
  agentIds: string[];
};

const PRIORITY_RANK: Record<IssuePriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  none: 3,
};

export function compareRunnableCandidates(left: Pick<QueueCandidate, "priority" | "activity" | "issueReference" | "agentId">, right: Pick<QueueCandidate, "priority" | "activity" | "issueReference" | "agentId">): number {
  return (
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
    Date.parse(left.activity.timestamp) - Date.parse(right.activity.timestamp) ||
    left.issueReference.number - right.issueReference.number ||
    (left.agentId ?? "").localeCompare(right.agentId ?? "")
  );
}

export function selectNextRunnableCandidate(results: { candidates: QueueCandidate[] }[]): QueueCandidate | undefined {
  return selectRunnableCandidates(results, 1)[0];
}

export function selectRunnableCandidates(results: { candidates: QueueCandidate[] }[], limit: number): QueueCandidate[] {
  if (limit < 1) {
    return [];
  }

  return results.flatMap((result) => result.candidates)
    .filter((candidate) => candidate.status === "runnable")
    .sort(compareRunnableCandidates)
    .slice(0, limit);
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

export function evaluateCheapIssueSkips(input: {
  repository: string;
  label: string;
  issue: GitHubIssue;
  machineId: string;
  trustedAuthors?: string[];
  configuredAgentIds?: string[];
  localState?: RunLocalState;
}): IssueSkipCheck {
  const priority = getIssuePriority(input.issue.labels);
  const activity = getIssueActivity(input.issue, []);
  const assignedAgentIds = getAssignedAgentIds(input.issue.labels);

  if (assignedAgentIds.length === 0) {
    return {
      skipped: true,
      candidates: [],
    };
  }

  if (!isTrustedIssueAuthor(input.issue.author, input.trustedAuthors)) {
    return {
      skipped: true,
      candidates: assignedAgentIds.map((agentId) => skippedCandidate(input, priority, activity, agentId, `untrusted issue creator ${input.issue.author}`)),
    };
  }

  if (hasCancelRequest(input.issue, input.label)) {
    return {
      skipped: true,
      candidates: assignedAgentIds.map((agentId) => skippedCandidate(input, priority, activity, agentId, "canceled")),
    };
  }

  if (!isAssignedToLocalMachine(input.issue.labels, input.machineId)) {
    return {
      skipped: true,
      candidates: assignedAgentIds.map((agentId) => skippedCandidate(input, priority, activity, agentId, "assigned to another machine")),
    };
  }

  const localAgentIds = assignedAgentIds.filter((agentId) => agentId.endsWith(`@${input.machineId}`));
  const configuredAgentIds = input.configuredAgentIds === undefined
    ? undefined
    : new Set(input.configuredAgentIds);
  const configuredLocalAgentIds = configuredAgentIds === undefined
    ? localAgentIds
    : localAgentIds.filter((agentId) => configuredAgentIds.has(agentId));
  const unconfiguredCandidates = configuredAgentIds === undefined
    ? []
    : localAgentIds
      .filter((agentId) => !configuredAgentIds.has(agentId))
      .map((agentId) => skippedCandidate(input, priority, activity, agentId, "agent not configured locally"));
  const lockedCandidates: QueueCandidate[] = [];
  const unlockedAgentIds: string[] = [];

  for (const agentId of configuredLocalAgentIds) {
    if (input.localState?.hasExecutionLock?.({
      repository: input.repository,
      issueNumber: input.issue.reference.number,
      agentId,
    }) === true) {
      lockedCandidates.push(skippedCandidate(input, priority, activity, agentId, "active local execution lock"));
    } else {
      unlockedAgentIds.push(agentId);
    }
  }

  if (unlockedAgentIds.length === 0) {
    return {
      skipped: true,
      candidates: [
        ...unconfiguredCandidates,
        ...lockedCandidates,
      ],
    };
  }

  return {
    skipped: false,
    agentIds: unlockedAgentIds,
  };
}

export function evaluateActivityCandidates(input: {
  repository: string;
  issue: GitHubIssue;
  relatedPullRequests: GitHubRelatedPullRequest[];
  agentIds: string[];
  localState?: RunLocalState;
}): QueueCandidate[] {
  const priority = getIssuePriority(input.issue.labels);
  const activity = getIssueActivity(input.issue, input.relatedPullRequests);
  const mergeabilityTrigger = findPullRequestMergeabilityTrigger(input.relatedPullRequests);

  return input.agentIds.map((agentId) => {
    const handledCursor = input.localState?.readHandledCursor?.({
      repository: input.repository,
      issueNumber: input.issue.reference.number,
      agentId,
    });

    if (handledCursor !== undefined && isHandledCursorCovered(handledCursor, activity)) {
      return skippedCandidate(input, priority, activity, agentId, "no unhandled activity");
    }

    if (
      handledCursor !== undefined &&
      isOwnAgentOutputOnlyDelta({
        issue: input.issue,
        relatedPullRequests: input.relatedPullRequests,
        agentId,
        handledThrough: handledCursor.handledThrough,
      })
    ) {
      return skippedCandidate(input, priority, activity, agentId, "only own agent output");
    }

    const candidateActivity = mergeabilityTrigger === undefined
      ? activity
      : {
        ...activity,
        trigger: mergeabilityTrigger,
      };

    return {
      repository: input.repository,
      issueReference: input.issue.reference,
      title: input.issue.title,
      agentId,
      status: "runnable",
      priority,
      activity: candidateActivity,
    };
  });
}

function isTrustedIssueAuthor(author: string, trustedAuthors: string[] | undefined): boolean {
  if (trustedAuthors === undefined) {
    return true;
  }

  const normalizedAuthor = author.toLowerCase();
  return trustedAuthors.some((trustedAuthor) => trustedAuthor.toLowerCase() === normalizedAuthor);
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
