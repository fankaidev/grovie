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

export type GitHubIssue = {
  reference: IssueReference;
  title: string;
  body: string;
  state: string;
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
};

type GitHubIssueResponse = {
  title: string;
  body: string | null;
  state: string;
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
