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
  GitHubRecentRepository,
  GitHubRelatedPullRequest,
  GitHubRepositoryEventsResult,
  GitHubUser,
  IssueReference,
  Result,
} from "./types.js";
import {
  toComment,
  toCreatedComment,
  toRepositoryEvent,
} from "./mappers.js";
import { formatRepository, parseRepositoryName } from "./parsing.js";
import type {
  GitHubCommentMutationResponse,
  GitHubCommentResponse,
  GitHubIssueListItemResponse,
  GitHubIssueResponse,
  GitHubPullRequestResponse,
  GitHubRepositoryEventResponse,
  GitHubRepositoryResponse,
  GitHubUserResponse,
} from "./responses.js";
import { GhApiClient } from "./api-client.js";
import { readPullRequestIssueLinks } from "./pull-request-links.js";
import { readRelatedPullRequests } from "./related-pull-requests.js";
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

  minimizeComment(commentNodeId: string, classifier: "OUTDATED" | "RESOLVED" = "OUTDATED"): Result<void> {
    const query = [
      "mutation($subjectId: ID!, $classifier: ReportedContentClassifiers!) {",
      "  minimizeComment(input: {subjectId: $subjectId, classifier: $classifier}) {",
      "    minimizedComment { isMinimized minimizedReason }",
      "  }",
      "}",
    ].join("\n");
    const result = this.runner.run("gh", [
      "api",
      "graphql",
      "-f",
      `subjectId=${commentNodeId}`,
      "-f",
      `classifier=${classifier}`,
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

    return {
      ok: true,
      value: undefined,
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
    return readRelatedPullRequests({
      api: this.api,
      runner: this.runner,
      reference,
    });
  }

  listRepositoryEvents(repository: string, options: { ifNoneMatch?: string } = {}): Result<GitHubRepositoryEventsResult> {
    const args = ["api", "-i"];

    if (options.ifNoneMatch !== undefined) {
      args.push("-H", `If-None-Match: ${options.ifNoneMatch}`);
    }

    args.push(`repos/${repository}/events?per_page=100`);
    const result = this.runner.run("gh", args);

    if (result.exitCode !== 0 && !isNotModifiedResponse(result.stdout)) {
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

    const parsed = parseIncludedGitHubResponse(result.stdout);

    if (parsed.status === 304) {
      return {
        ok: true,
        value: {
          status: "not-modified",
          etag: parsed.headers.etag,
          pollIntervalSeconds: parsePollInterval(parsed.headers["x-poll-interval"]),
        },
      };
    }

    if (parsed.status < 200 || parsed.status >= 300) {
      return {
        ok: false,
        error: {
          code: "gh_failed",
          message: result.stderr.trim() || `gh ${args.join(" ")} returned HTTP ${parsed.status}.`,
          command: `gh ${args.join(" ")}`,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    }

    let events: GitHubRepositoryEventResponse[];

    try {
      events = JSON.parse(parsed.body) as GitHubRepositoryEventResponse[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: {
          code: "invalid_json",
          message: `gh ${args.join(" ")} returned invalid JSON: ${message}`,
          command: `gh ${args.join(" ")}`,
          stderr: parsed.body,
        },
      };
    }

    return {
      ok: true,
      value: {
        status: "modified",
        events: events.map(toRepositoryEvent),
        etag: parsed.headers.etag,
        pollIntervalSeconds: parsePollInterval(parsed.headers["x-poll-interval"]),
      },
    };
  }

  readPullRequestIssueLinks(repository: string, pullRequestNumber: number): Result<GitHubPullRequestIssueLink[]> {
    return readPullRequestIssueLinks({
      runner: this.runner,
      repository,
      pullRequestNumber,
    });
  }

  listRecentRepositories(limit: number): Result<GitHubRecentRepository[]> {
    const args = [
      "repo",
      "list",
      "--limit",
      String(limit),
      "--json",
      "nameWithOwner,isPrivate,updatedAt",
    ];
    const result = this.runner.run("gh", args);

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

    let repositories: Array<{ nameWithOwner: string; isPrivate: boolean; updatedAt: string }>;

    try {
      repositories = JSON.parse(result.stdout) as Array<{ nameWithOwner: string; isPrivate: boolean; updatedAt: string }>;
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

    return {
      ok: true,
      value: repositories.map((repository) => ({
        repository: repository.nameWithOwner,
        private: repository.isPrivate,
        updatedAt: repository.updatedAt,
      })),
    };
  }

}

function isNotModifiedResponse(output: string): boolean {
  return /^HTTP\/\S+\s+304\b/m.test(output);
}

function parseIncludedGitHubResponse(output: string): { status: number; headers: Record<string, string>; body: string } {
  const normalized = output.replace(/\r\n/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headerText = separatorIndex < 0 ? normalized : normalized.slice(0, separatorIndex);
  const body = separatorIndex < 0 ? "" : normalized.slice(separatorIndex + 2);
  const [statusLine = "", ...headerLines] = headerText.split("\n");
  const status = Number.parseInt(statusLine.split(/\s+/)[1] ?? "0", 10);
  const headers: Record<string, string> = {};

  for (const line of headerLines) {
    const separator = line.indexOf(":");

    if (separator < 0) {
      continue;
    }

    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }

  return {
    status,
    headers,
    body,
  };
}

function parsePollInterval(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const interval = Number.parseInt(value, 10);
  return Number.isFinite(interval) && interval > 0 ? interval : undefined;
}
