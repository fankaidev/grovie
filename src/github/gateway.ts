import type {
  CreatedComment,
  CreatedPullRequest,
  CreatedRepository,
  CommandRunner,
  CreatePullRequestInput,
  GitHubGateway,
  GitHubIssue,
  GitHubIssueSummary,
  GitHubPullRequestIssueLink,
  GitHubRelatedPullRequest,
  GitHubRepositoryEvent,
  GitHubUser,
  IssueReference,
  Result,
} from "./types.js";
import {
  isPullRequestRelatedToIssue,
  normalizeMergeStateStatus,
  summarizeCheckRuns,
  toComment,
  toCreatedComment,
  toPullRequestReview,
  toRepositoryEvent,
} from "./mappers.js";
import { formatRepository, parseRepositoryName } from "./parsing.js";
import type {
  GitHubCheckRunsResponse,
  GitHubCommentMutationResponse,
  GitHubCommentResponse,
  GitHubIssueListItemResponse,
  GitHubIssueResponse,
  GitHubPullRequestDetailsResponse,
  GitHubPullRequestListItemResponse,
  GitHubPullRequestResponse,
  GitHubPullRequestReviewResponse,
  GitHubRepositoryEventResponse,
  GitHubRepositoryResponse,
  GitHubUserResponse,
} from "./responses.js";
import { GhApiClient } from "./api-client.js";
import { readPullRequestIssueLinks } from "./pull-request-links.js";
import { SpawnCommandRunner } from "./runner.js";

export class GhGitHubGateway implements GitHubGateway {
  private readonly api: GhApiClient;

  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {
    this.api = new GhApiClient(runner);
  }

  getAuthenticatedUser(): Result<GitHubUser> {
    const result = this.api.json<GitHubUserResponse>("user");

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: {
        login: result.value.login,
      },
    };
  }

  listOpenIssues(repository: string, label: string): Result<GitHubIssueSummary[]> {
    const parsedRepository = parseRepositoryName(repository);

    if (!parsedRepository.ok) {
      return parsedRepository;
    }

    const result = this.api.json<GitHubIssueListItemResponse[][]>(
      `repos/${repository}/issues?state=open&labels=${encodeURIComponent(label)}`,
      {
        paginate: true,
        slurp: true,
      },
    );

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: result.value
        .flat()
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({
          reference: {
            owner: parsedRepository.value.owner,
            repo: parsedRepository.value.repo,
            number: issue.number,
          },
          title: issue.title,
          labels: issue.labels.map((candidate) => candidate.name),
        })),
    };
  }

  readIssue(reference: IssueReference): Result<GitHubIssue> {
    const repository = formatRepository(reference);
    const issueResult = this.api.json<GitHubIssueResponse>(`repos/${repository}/issues/${reference.number}`);

    if (!issueResult.ok) {
      return issueResult;
    }

    const repoResult = this.api.json<GitHubRepositoryResponse>(`repos/${repository}`);

    if (!repoResult.ok) {
      return repoResult;
    }

    const commentsResult = this.api.json<GitHubCommentResponse[][]>(
      `repos/${repository}/issues/${reference.number}/comments`,
      {
        paginate: true,
        slurp: true,
      },
    );

    if (!commentsResult.ok) {
      return commentsResult;
    }

    return {
      ok: true,
      value: {
        reference,
        title: issueResult.value.title,
        body: issueResult.value.body ?? "",
        author: issueResult.value.user?.login ?? "unknown",
        state: issueResult.value.state,
        updatedAt: issueResult.value.updated_at,
        labels: issueResult.value.labels.map((label) => label.name),
        comments: commentsResult.value.flat().map(toComment),
        defaultBranch: repoResult.value.default_branch,
      },
    };
  }

  addLabels(reference: IssueReference, labels: string[]): Result<void> {
    const repository = formatRepository(reference);
    const result = this.api.json<unknown>(`repos/${repository}/issues/${reference.number}/labels`, {
      method: "POST",
      body: {
        labels,
      },
    });

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: undefined,
    };
  }

  removeLabel(reference: IssueReference, label: string): Result<void> {
    const repository = formatRepository(reference);
    const result = this.api.json<unknown>(
      `repos/${repository}/issues/${reference.number}/labels/${encodeURIComponent(label)}`,
      {
        method: "DELETE",
      },
    );

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: undefined,
    };
  }

  createIssueComment(reference: IssueReference, body: string): Result<CreatedComment> {
    const repository = formatRepository(reference);
    const result = this.api.json<GitHubCommentMutationResponse>(`repos/${repository}/issues/${reference.number}/comments`, {
      method: "POST",
      body: {
        body,
      },
    });

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: toCreatedComment(result.value),
    };
  }

  updateIssueComment(repository: string, commentId: number, body: string): Result<CreatedComment> {
    const result = this.api.json<GitHubCommentMutationResponse>(`repos/${repository}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: {
        body,
      },
    });

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: toCreatedComment(result.value),
    };
  }

  createPullRequest(input: CreatePullRequestInput): Result<CreatedPullRequest> {
    const result = this.api.json<GitHubPullRequestResponse>(`repos/${input.repository}/pulls`, {
      method: "POST",
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
      },
    });

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: {
        number: result.value.number,
        url: result.value.html_url,
      },
    };
  }

  listRepositoryOwners(): Result<string[]> {
    const user = this.getAuthenticatedUser();

    if (!user.ok) {
      return {
        ok: false,
        error: user.error,
      };
    }

    const orgs = this.api.json<Array<{ login: string }>[]>("user/orgs", {
      paginate: true,
      slurp: true,
    });

    if (!orgs.ok) {
      return orgs;
    }

    return {
      ok: true,
      value: [user.value.login, ...orgs.value.flat().map((org) => org.login)],
    };
  }

  readRepository(repository: string): Result<CreatedRepository> {
    const result = this.api.json<GitHubRepositoryResponse>(`repos/${repository}`);

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: {
        repository: result.value.full_name,
        private: result.value.private,
        url: result.value.html_url,
      },
    };
  }

  createRepository(input: { repository: string; private: boolean }): Result<CreatedRepository> {
    const parsed = parseRepositoryName(input.repository);

    if (!parsed.ok) {
      return parsed;
    }

    const authenticated = this.getAuthenticatedUser();

    if (!authenticated.ok) {
      return {
        ok: false,
        error: authenticated.error,
      };
    }

    const path = parsed.value.owner === authenticated.value.login
      ? "user/repos"
      : `orgs/${parsed.value.owner}/repos`;
    const result = this.api.json<GitHubRepositoryResponse>(path, {
      method: "POST",
      body: {
        name: parsed.value.repo,
        private: input.private,
        auto_init: true,
      },
    });

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: {
        repository: result.value.full_name,
        private: result.value.private,
        url: result.value.html_url,
      },
    };
  }

  readRelatedPullRequests(reference: IssueReference): Result<GitHubRelatedPullRequest[]> {
    const repository = formatRepository(reference);
    const result = this.api.json<GitHubPullRequestListItemResponse[][]>(
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
      .filter((pullRequest) => isPullRequestRelatedToIssue(pullRequest, reference.number));
    const contexts: GitHubRelatedPullRequest[] = [];

    for (const pullRequest of related) {
      const detailsResult = this.api.json<GitHubPullRequestDetailsResponse>(`repos/${repository}/pulls/${pullRequest.number}`);

      if (!detailsResult.ok) {
        return detailsResult;
      }

      const commentsResult = this.api.json<GitHubCommentResponse[][]>(
        `repos/${repository}/issues/${pullRequest.number}/comments`,
        {
          paginate: true,
          slurp: true,
        },
      );

      if (!commentsResult.ok) {
        return commentsResult;
      }

      const reviewCommentsResult = this.api.json<GitHubCommentResponse[][]>(
        `repos/${repository}/pulls/${pullRequest.number}/comments`,
        {
          paginate: true,
          slurp: true,
        },
      );

      if (!reviewCommentsResult.ok) {
        return reviewCommentsResult;
      }

      const reviewsResult = this.api.json<GitHubPullRequestReviewResponse[][]>(
        `repos/${repository}/pulls/${pullRequest.number}/reviews`,
        {
          paginate: true,
          slurp: true,
        },
      );

      if (!reviewsResult.ok) {
        return reviewsResult;
      }

      const checksResult = this.api.json<GitHubCheckRunsResponse>(
        `repos/${repository}/commits/${pullRequest.head.sha}/check-runs`,
      );

      if (!checksResult.ok) {
        return checksResult;
      }

      const diffResult = this.runner.run("gh", ["pr", "diff", String(pullRequest.number), "--repo", repository, "--name-only"], undefined, {
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

  listRepositoryEvents(repository: string): Result<GitHubRepositoryEvent[]> {
    const result = this.api.json<GitHubRepositoryEventResponse[]>(`repos/${repository}/events?per_page=100`);

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: result.value.map(toRepositoryEvent),
    };
  }

  readPullRequestIssueLinks(repository: string, pullRequestNumber: number): Result<GitHubPullRequestIssueLink[]> {
    return readPullRequestIssueLinks({
      runner: this.runner,
      repository,
      pullRequestNumber,
    });
  }

}
