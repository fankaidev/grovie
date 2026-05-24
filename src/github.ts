import { spawnSync } from "node:child_process";

export type Result<T> =
  | {
    ok: true;
    value: T;
  }
  | {
    ok: false;
    error: GitHubGatewayError;
  };

export type GitHubGatewayError = {
  code: "gh_failed" | "invalid_issue_reference" | "invalid_json";
  message: string;
  command?: string;
  exitCode?: number;
  stderr?: string;
};

export type CommandRunner = {
  run(command: string, args: string[], input?: string, options?: CommandRunOptions): CommandResult;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
};

export type IssueReference = {
  owner: string;
  repo: string;
  number: number;
};

export type GitHubUser = {
  login: string;
};

export type GitHubLabel = {
  name: string;
};

export type GitHubComment = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPullRequestReview = {
  id: number;
  state: string;
  author: string;
  body: string;
  submittedAt: string;
};

export type GitHubCheckSummary = {
  totalCount: number;
  conclusionCounts: Record<string, number>;
};

export type GitHubRelatedPullRequest = {
  number: number;
  title: string;
  state: string;
  mergeStateStatus?: string;
  url: string;
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  updatedAt: string;
  comments: GitHubComment[];
  reviewComments: GitHubComment[];
  reviews: GitHubPullRequestReview[];
  checks: GitHubCheckSummary;
  diffSummary?: string;
};

export type GitHubRepositoryEvent = {
  id: string;
  type: string;
  createdAt: string;
  actor: string;
  action?: string;
  issueNumber?: number;
  issueUrl?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  commentUrl?: string;
  reviewUrl?: string;
};

export type GitHubPullRequestIssueLink = {
  pullRequestNumber: number;
  issueNumber: number;
  source: "closing-reference" | "body" | "branch";
};

export type GitHubIssue = {
  reference: IssueReference;
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  labels: string[];
  comments: GitHubComment[];
  defaultBranch: string;
};

export type GitHubIssueSummary = {
  reference: IssueReference;
  title: string;
  labels: string[];
};

export type CreatedComment = {
  id: number;
  body: string;
  url: string;
};

export type CreatedPullRequest = {
  number: number;
  url: string;
};

export type CreatedRepository = {
  repository: string;
  private: boolean;
  url: string;
};

export type CreatePullRequestInput = {
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
};

export type GitHubGateway = {
  getAuthenticatedUser(): Result<GitHubUser>;
  listOpenIssues(repository: string, label: string): Result<GitHubIssueSummary[]>;
  readIssue(reference: IssueReference): Result<GitHubIssue>;
  addLabels(reference: IssueReference, labels: string[]): Result<void>;
  removeLabel(reference: IssueReference, label: string): Result<void>;
  createIssueComment(reference: IssueReference, body: string): Result<CreatedComment>;
  updateIssueComment(repository: string, commentId: number, body: string): Result<CreatedComment>;
  createPullRequest(input: CreatePullRequestInput): Result<CreatedPullRequest>;
  readRelatedPullRequests?(reference: IssueReference): Result<GitHubRelatedPullRequest[]>;
  listRepositoryEvents?(repository: string): Result<GitHubRepositoryEvent[]>;
  readPullRequestIssueLinks?(repository: string, pullRequestNumber: number): Result<GitHubPullRequestIssueLink[]>;
  listRepositoryOwners?(): Result<string[]>;
  readRepository?(repository: string): Result<CreatedRepository>;
  createRepository?(input: { repository: string; private: boolean }): Result<CreatedRepository>;
};

export class GhGitHubGateway implements GitHubGateway {
  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {}

  getAuthenticatedUser(): Result<GitHubUser> {
    const result = this.apiJson<GitHubUserResponse>("user");

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

    const result = this.apiJson<GitHubIssueListItemResponse[][]>(
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
    const issueResult = this.apiJson<GitHubIssueResponse>(`repos/${repository}/issues/${reference.number}`);

    if (!issueResult.ok) {
      return issueResult;
    }

    const repoResult = this.apiJson<GitHubRepositoryResponse>(`repos/${repository}`);

    if (!repoResult.ok) {
      return repoResult;
    }

    const commentsResult = this.apiJson<GitHubCommentResponse[][]>(
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
    const result = this.apiJson<unknown>(`repos/${repository}/issues/${reference.number}/labels`, {
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
    const result = this.apiJson<unknown>(
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
    const result = this.apiJson<GitHubCommentMutationResponse>(`repos/${repository}/issues/${reference.number}/comments`, {
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
    const result = this.apiJson<GitHubCommentMutationResponse>(`repos/${repository}/issues/comments/${commentId}`, {
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
    const result = this.apiJson<GitHubPullRequestResponse>(`repos/${input.repository}/pulls`, {
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

    const orgs = this.apiJson<Array<{ login: string }>[]>("user/orgs", {
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
    const result = this.apiJson<GitHubRepositoryResponse>(`repos/${repository}`);

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
    const result = this.apiJson<GitHubRepositoryResponse>(path, {
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
    const result = this.apiJson<GitHubPullRequestListItemResponse[][]>(
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
      const detailsResult = this.apiJson<GitHubPullRequestDetailsResponse>(`repos/${repository}/pulls/${pullRequest.number}`);

      if (!detailsResult.ok) {
        return detailsResult;
      }

      const commentsResult = this.apiJson<GitHubCommentResponse[][]>(
        `repos/${repository}/issues/${pullRequest.number}/comments`,
        {
          paginate: true,
          slurp: true,
        },
      );

      if (!commentsResult.ok) {
        return commentsResult;
      }

      const reviewCommentsResult = this.apiJson<GitHubCommentResponse[][]>(
        `repos/${repository}/pulls/${pullRequest.number}/comments`,
        {
          paginate: true,
          slurp: true,
        },
      );

      if (!reviewCommentsResult.ok) {
        return reviewCommentsResult;
      }

      const reviewsResult = this.apiJson<GitHubPullRequestReviewResponse[][]>(
        `repos/${repository}/pulls/${pullRequest.number}/reviews`,
        {
          paginate: true,
          slurp: true,
        },
      );

      if (!reviewsResult.ok) {
        return reviewsResult;
      }

      const checksResult = this.apiJson<GitHubCheckRunsResponse>(
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
    const result = this.apiJson<GitHubRepositoryEventResponse[]>(`repos/${repository}/events?per_page=100`);

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: result.value.map(toRepositoryEvent),
    };
  }

  readPullRequestIssueLinks(repository: string, pullRequestNumber: number): Result<GitHubPullRequestIssueLink[]> {
    const parsedRepository = parseRepositoryName(repository);

    if (!parsedRepository.ok) {
      return parsedRepository;
    }

    const query = [
      "query($owner: String!, $name: String!, $number: Int!) {",
      "  repository(owner: $owner, name: $name) {",
      "    pullRequest(number: $number) {",
      "      body",
      "      headRefName",
      "      closingIssuesReferences(first: 20) { nodes { number } }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const result = this.runner.run("gh", [
      "api",
      "graphql",
      "-f",
      `owner=${parsedRepository.value.owner}`,
      "-f",
      `name=${parsedRepository.value.repo}`,
      "-F",
      `number=${pullRequestNumber}`,
      "-f",
      `query=${query}`,
    ]);

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "gh_failed",
          message: result.stderr.trim() || `gh api graphql failed with exit code ${result.exitCode}.`,
          command: "gh api graphql",
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as GitHubPullRequestIssueLinksGraphqlResponse;
      const pullRequest = parsed.data?.repository?.pullRequest;

      if (pullRequest === undefined || pullRequest === null) {
        return {
          ok: true,
          value: [],
        };
      }

      return {
        ok: true,
        value: parsePullRequestIssueLinks({
          pullRequestNumber,
          body: pullRequest.body ?? "",
          headRefName: pullRequest.headRefName ?? "",
          closingIssueNumbers: pullRequest.closingIssuesReferences?.nodes
            ?.map((node) => node?.number)
            .filter((number): number is number => typeof number === "number") ?? [],
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: {
          code: "invalid_json",
          message: `gh api graphql returned invalid JSON: ${message}`,
          command: "gh api graphql",
          stderr: result.stdout,
        },
      };
    }
  }

  private apiJson<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      paginate?: boolean;
      slurp?: boolean;
    } = {},
  ): Result<T> {
    const args = ["api"];

    if (options.method !== undefined) {
      args.push("-X", options.method);
    }

    if (options.paginate === true) {
      args.push("--paginate");
    }

    if (options.slurp === true) {
      args.push("--slurp");
    }

    args.push(path);

    const input = options.body === undefined ? undefined : `${JSON.stringify(options.body)}\n`;

    if (input !== undefined) {
      args.push("--input", "-");
    }

    const result = this.runner.run("gh", args, input);

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "gh_failed",
          message: result.stderr.trim() || `gh ${args.join(" ")} failed with exit code ${result.exitCode}.`,
          command: `gh ${args.join(" ")}`,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    }

    if (result.stdout.trim().length === 0) {
      return {
        ok: true,
        value: undefined as T,
      };
    }

    try {
      return {
        ok: true,
        value: JSON.parse(result.stdout) as T,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: {
          code: "invalid_json",
          message: `gh ${args.join(" ")} returned invalid JSON: ${message}`,
          command: `gh ${args.join(" ")}`,
          stderr: result.stdout,
        },
      };
    }
  }
}

export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: string[], input?: string, options: CommandRunOptions = {}): CommandResult {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      input,
      maxBuffer: options.maxBuffer,
    });

    if (result.error !== undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: result.error.message,
      };
    }

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

export function parseIssueReference(value: string): Result<IssueReference> {
  const match = /^(?<owner>[A-Za-z0-9.-]+)\/(?<repo>[A-Za-z0-9._-]+)#(?<number>[1-9]\d*)$/.exec(value);

  if (match?.groups === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: `Invalid issue reference "${value}". Expected owner/repo#123.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      owner: match.groups.owner,
      repo: match.groups.repo,
      number: Number.parseInt(match.groups.number, 10),
    },
  };
}

export function formatIssueReference(reference: IssueReference): string {
  return `${formatRepository(reference)}#${reference.number}`;
}

export function formatRepository(reference: Pick<IssueReference, "owner" | "repo">): string {
  return `${reference.owner}/${reference.repo}`;
}

export function parseRepositoryName(repository: string): Result<Pick<IssueReference, "owner" | "repo">> {
  const match = /^(?<owner>[A-Za-z0-9.-]+)\/(?<repo>[A-Za-z0-9._-]+)$/.exec(repository);

  if (match?.groups === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: `Invalid repository "${repository}". Expected owner/repo.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      owner: match.groups.owner,
      repo: match.groups.repo,
    },
  };
}

type GitHubUserResponse = {
  login: string;
};

type GitHubRepositoryResponse = {
  default_branch: string;
  full_name: string;
  private: boolean;
  html_url: string;
};

type GitHubIssueResponse = {
  title: string;
  body: string | null;
  state: string;
  updated_at: string;
  labels: GitHubLabel[];
};

type GitHubIssueListItemResponse = {
  number: number;
  title: string;
  labels: GitHubLabel[];
  pull_request?: unknown;
};

type GitHubCommentResponse = {
  id: number;
  body: string;
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
};

type GitHubCommentMutationResponse = {
  id: number;
  body: string;
  html_url: string;
};

type GitHubPullRequestResponse = {
  number: number;
  html_url: string;
};

type GitHubPullRequestListItemResponse = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  updated_at: string;
  base: {
    ref: string;
  };
  head: {
    ref: string;
    sha: string;
  };
};

type GitHubPullRequestDetailsResponse = {
  mergeable_state?: string | null;
};

type GitHubPullRequestReviewResponse = {
  id: number;
  state: string;
  body: string | null;
  user: {
    login: string;
  };
  submitted_at: string | null;
};

type GitHubCheckRunResponse = {
  conclusion: string | null;
};

type GitHubCheckRunsResponse = {
  total_count: number;
  check_runs: GitHubCheckRunResponse[];
};

type GitHubRepositoryEventResponse = {
  id: string;
  type: string;
  created_at: string;
  actor?: {
    login?: string;
  };
  payload?: {
    action?: string;
    issue?: {
      number?: number;
      html_url?: string;
    };
    pull_request?: {
      number?: number;
      html_url?: string | null;
    };
    comment?: {
      html_url?: string;
    };
    review?: {
      html_url?: string;
    };
  };
};

type GitHubPullRequestIssueLinksGraphqlResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        body?: string | null;
        headRefName?: string | null;
        closingIssuesReferences?: {
          nodes?: Array<{
            number?: number;
          } | null>;
        };
      } | null;
    } | null;
  };
};

function toComment(comment: GitHubCommentResponse): GitHubComment {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.user.login,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function toCreatedComment(comment: GitHubCommentMutationResponse): CreatedComment {
  return {
    id: comment.id,
    body: comment.body,
    url: comment.html_url,
  };
}

function toPullRequestReview(review: GitHubPullRequestReviewResponse): GitHubPullRequestReview {
  return {
    id: review.id,
    state: review.state,
    author: review.user.login,
    body: review.body ?? "",
    submittedAt: review.submitted_at ?? "",
  };
}

function summarizeCheckRuns(checkRuns: GitHubCheckRunResponse[]): GitHubCheckSummary {
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

function normalizeMergeStateStatus(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim().toUpperCase();
}

function toRepositoryEvent(event: GitHubRepositoryEventResponse): GitHubRepositoryEvent {
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

function isPullRequestRelatedToIssue(pullRequest: GitHubPullRequestListItemResponse, issueNumber: number): boolean {
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

function parsePullRequestIssueLinks(input: {
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
