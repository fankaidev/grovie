import { isPullRequestRelatedToIssue, normalizeMergeStateStatus, summarizeCheckRuns, toComment, toPullRequestReview } from "./mappers.js";
import { formatRepository } from "./parsing.js";
import type {
  GitHubCheckRunsResponse,
  GitHubCommentResponse,
  GitHubPullRequestDetailsResponse,
  GitHubPullRequestListItemResponse,
  GitHubPullRequestReviewResponse,
} from "./responses.js";
import type { CommandRunner, GitHubRelatedPullRequest, IssueReference, Result } from "./types.js";
import type { GhApiClient } from "./api-client.js";

export function readRelatedPullRequests(input: {
  api: GhApiClient;
  runner: CommandRunner;
  reference: IssueReference;
}): Result<GitHubRelatedPullRequest[]> {
  const repository = formatRepository(input.reference);
  const result = input.api.json<GitHubPullRequestListItemResponse[][]>(
    `repos/${repository}/pulls?state=all&per_page=100`,
    {
      paginate: true,
      slurp: true,
    },
  );

  if (!result.ok) {
    return result;
  }

  const related = result.value
    .flat()
    .filter((pullRequest) => isPullRequestRelatedToIssue(pullRequest, input.reference.number));
  const contexts: GitHubRelatedPullRequest[] = [];

  for (const pullRequest of related) {
    const detailsResult = input.api.json<GitHubPullRequestDetailsResponse>(`repos/${repository}/pulls/${pullRequest.number}`);

    if (!detailsResult.ok) {
      return detailsResult;
    }

    const commentsResult = input.api.json<GitHubCommentResponse[][]>(
      `repos/${repository}/issues/${pullRequest.number}/comments`,
      {
        paginate: true,
        slurp: true,
      },
    );

    if (!commentsResult.ok) {
      return commentsResult;
    }

    const reviewCommentsResult = input.api.json<GitHubCommentResponse[][]>(
      `repos/${repository}/pulls/${pullRequest.number}/comments`,
      {
        paginate: true,
        slurp: true,
      },
    );

    if (!reviewCommentsResult.ok) {
      return reviewCommentsResult;
    }

    const reviewsResult = input.api.json<GitHubPullRequestReviewResponse[][]>(
      `repos/${repository}/pulls/${pullRequest.number}/reviews`,
      {
        paginate: true,
        slurp: true,
      },
    );

    if (!reviewsResult.ok) {
      return reviewsResult;
    }

    const checksResult = input.api.json<GitHubCheckRunsResponse>(
      `repos/${repository}/commits/${pullRequest.head.sha}/check-runs`,
    );

    if (!checksResult.ok) {
      return checksResult;
    }

    const diffResult = input.runner.run("gh", ["pr", "diff", String(pullRequest.number), "--repo", repository, "--name-only"], undefined, {
      maxBuffer: 1024 * 1024,
    });

    if (diffResult.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "gh_failed",
          message: diffResult.stderr.trim() || `gh pr diff ${pullRequest.number} failed with exit code ${diffResult.exitCode}.`,
          command: `gh pr diff ${pullRequest.number} --repo ${repository} --name-only`,
          exitCode: diffResult.exitCode,
          stderr: diffResult.stderr,
        },
      };
    }

    contexts.push({
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      mergeStateStatus: normalizeMergeStateStatus(detailsResult.value.mergeable_state),
      url: pullRequest.html_url,
      body: pullRequest.body ?? "",
      baseRef: pullRequest.base.ref,
      headRef: pullRequest.head.ref,
      headSha: pullRequest.head.sha,
      updatedAt: pullRequest.updated_at,
      comments: commentsResult.value.flat().map(toComment),
      reviewComments: reviewCommentsResult.value.flat().map(toComment),
      reviews: reviewsResult.value.flat().map(toPullRequestReview),
      checks: summarizeCheckRuns(checksResult.value.check_runs),
      diffSummary: diffResult.stdout.trim() || undefined,
    });
  }

  return {
    ok: true,
    value: contexts,
  };
}
