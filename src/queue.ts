import {
  parseRepositoryName,
  type GitHubGateway,
  type GitHubIssue,
  type IssueReference,
} from "./github.js";
import { type IssueActivity } from "./queue/activity.js";
import {
  compareRunnableCandidates,
  evaluateActivityCandidates,
  evaluateCheapIssueSkips,
} from "./queue/candidates.js";
import type { RunLocalState } from "./run.js";

export { getIssueActivity } from "./queue/activity.js";
export { compareRunnableCandidates, getIssuePriority, selectNextRunnableCandidate, selectRunnableCandidates } from "./queue/candidates.js";
export { renderQueueInspection, renderSkippedQueueSummary } from "./queue/render.js";
export type { IssueActivity, IssueActivityTrigger } from "./queue/activity.js";

export type QueueRepositoryInput = {
  repository: string;
  label: string;
  trustedAuthors?: string[];
  issueNumbers?: number[];
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
  const issueNumbers = repository.issueNumbers ?? input.issueNumbers;

  if (issueNumbers !== undefined) {
    const parsedRepository = parseRepositoryName(repository.repository);

    if (!parsedRepository.ok) {
      return {
        ok: false,
        message: parsedRepository.error.message,
      };
    }

    const issues: GitHubIssue[] = [];

    for (const issueNumber of issueNumbers) {
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
