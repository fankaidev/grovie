import { getAssignedAgentIds, isAssignedToLocalMachine } from "./assignment.js";
import { hasCancelRequest } from "./claim.js";
import {
  parseRepositoryName,
  type GitHubGateway,
  type GitHubIssue,
  type GitHubRelatedPullRequest,
  type IssueReference,
} from "./github.js";
import { findPullRequestMergeabilityTrigger, getIssueActivity, type IssueActivity } from "./queue/activity.js";
import type { RunLocalState } from "./run.js";

export { getIssueActivity } from "./queue/activity.js";
export { renderQueueInspection, renderSkippedQueueSummary } from "./queue/render.js";
export type { IssueActivity, IssueActivityTrigger } from "./queue/activity.js";

export type QueueRepositoryInput = {
  repository: string;
  label: string;
  trustedAuthors?: string[];
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

type IssueSkipCheck = {
  skipped: true;
  candidates: QueueCandidate[];
} | {
  skipped: false;
  agentIds: string[];
};

export type QueueInspectionResult = {
  repository: string;
  label: string;
  candidates: QueueCandidate[];
};

export type IssuePriority = "p0" | "p1" | "p2" | "none";

export type QueueInspectionInput = {
  repositories: QueueRepositoryInput[];
  github: GitHubGateway;
  machineId: string;
  trustedAuthors?: string[];
  configuredAgentIds?: string[];
  localState?: RunLocalState;
  issueNumbers?: number[];
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
    const candidates: QueueCandidate[] = [];
    const issuesResult = readQueueIssues(input, repository);

    if (!issuesResult.ok) {
      return {
        ok: false,
        message: issuesResult.message,
      };
    }

    for (const issue of issuesResult.value) {
      const cheapCheck = evaluateCheapIssueSkips({
        repository: repository.repository,
        label: repository.label,
        issue,
        machineId: input.machineId,
        trustedAuthors: repository.trustedAuthors ?? input.trustedAuthors,
        configuredAgentIds: input.configuredAgentIds,
        localState: input.localState,
      });

      if (cheapCheck.skipped) {
        candidates.push(...cheapCheck.candidates);
        continue;
      }

      const relatedPullRequestsResult = input.github.readRelatedPullRequests?.(issue.reference) ?? {
        ok: true as const,
        value: [],
      };

      if (!relatedPullRequestsResult.ok) {
        return {
          ok: false,
          message: relatedPullRequestsResult.error.message,
        };
      }

      candidates.push(...evaluateActivityCandidates({
        repository: repository.repository,
        issue,
        relatedPullRequests: relatedPullRequestsResult.value,
        agentIds: cheapCheck.agentIds,
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

function readQueueIssues(
  input: QueueInspectionInput,
  repository: QueueRepositoryInput,
): { ok: true; value: GitHubIssue[] } | { ok: false; message: string } {
  if (input.issueNumbers !== undefined) {
    const parsedRepository = parseRepositoryName(repository.repository);

    if (!parsedRepository.ok) {
      return {
        ok: false,
        message: parsedRepository.error.message,
      };
    }

    const issues: GitHubIssue[] = [];

    for (const issueNumber of input.issueNumbers) {
      const issueResult = input.github.readIssue({
        ...parsedRepository.value,
        number: issueNumber,
      });

      if (!issueResult.ok) {
        return {
          ok: false,
          message: issueResult.error.message,
        };
      }

      if (issueResult.value.state === "open" && issueResult.value.labels.includes(repository.label)) {
        issues.push(issueResult.value);
      }
    }

    return {
      ok: true,
      value: issues,
    };
  }

  const listResult = input.github.listOpenIssues(repository.repository, repository.label);

  if (!listResult.ok) {
    return {
      ok: false,
      message: listResult.error.message,
    };
  }

  const issues: GitHubIssue[] = [];

  for (const summary of listResult.value) {
    const issueResult = input.github.readIssue(summary.reference);

    if (!issueResult.ok) {
      return {
        ok: false,
        message: issueResult.error.message,
      };
    }

    issues.push(issueResult.value);
  }

  return {
    ok: true,
    value: issues,
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

function evaluateCheapIssueSkips(input: {
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

function isTrustedIssueAuthor(author: string, trustedAuthors: string[] | undefined): boolean {
  if (trustedAuthors === undefined) {
    return true;
  }

  const normalizedAuthor = author.toLowerCase();
  return trustedAuthors.some((trustedAuthor) => trustedAuthor.toLowerCase() === normalizedAuthor);
}

function evaluateActivityCandidates(input: {
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
