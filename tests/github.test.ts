import { describe, expect, it } from "vitest";
import { GhGitHubGateway, SpawnCommandRunner, type CommandResult, type CommandRunner, parseIssueReference } from "../src/github.js";

describe("parseIssueReference", () => {
  it("parses owner/repo issue references", () => {
    expect(parseIssueReference("fankaidev/grovie#123")).toEqual({
      ok: true,
      value: {
        owner: "fankaidev",
        repo: "grovie",
        number: 123,
      },
    });
  });

  it("rejects invalid issue references with structured errors", () => {
    expect(parseIssueReference("fankaidev/grovie/extra#123")).toEqual({
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: 'Invalid issue reference "fankaidev/grovie/extra#123". Expected owner/repo#123.',
      },
    });
  });

  it("rejects zero, missing, and non-numeric issue numbers", () => {
    for (const value of ["fankaidev/grovie#0", "fankaidev/grovie#", "fankaidev/grovie#abc"]) {
      expect(parseIssueReference(value)).toEqual({
        ok: false,
        error: {
          code: "invalid_issue_reference",
          message: `Invalid issue reference "${value}". Expected owner/repo#123.`,
        },
      });
    }
  });
});

describe("GhGitHubGateway", () => {
  it("[UC-DAEMON-02-S17] detects the authenticated GitHub user through gh", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({ login: "fankaidev" }),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.getAuthenticatedUser()).toEqual({
      ok: true,
      value: {
        login: "fankaidev",
      },
    });
    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["api", "user"],
        input: undefined,
      },
    ]);
  });

  it("[UC-RUN-02-S03] reads issue details, default branch, and comments", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          title: "Implement config",
          body: null,
          user: { login: "fankaidev" },
          state: "open",
          updated_at: "2026-05-22T00:00:02Z",
          labels: [{ name: "mvp" }, { name: "type:task" }],
        }),
      },
      {
        stdout: JSON.stringify({
          default_branch: "main",
        }),
      },
      {
        stdout: JSON.stringify([
          [
            {
              id: 42,
              body: "Started",
              user: { login: "fankaidev" },
              created_at: "2026-05-22T00:00:00Z",
              updated_at: "2026-05-22T00:00:01Z",
            },
          ],
        ]),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.readIssue({ owner: "fankaidev", repo: "grovie", number: 3 })).toEqual({
      ok: true,
      value: {
        reference: {
          owner: "fankaidev",
          repo: "grovie",
          number: 3,
        },
        title: "Implement config",
        body: "",
        author: "fankaidev",
        state: "open",
        updatedAt: "2026-05-22T00:00:02Z",
        labels: ["mvp", "type:task"],
        comments: [
          {
            id: 42,
            body: "Started",
            author: "fankaidev",
            createdAt: "2026-05-22T00:00:00Z",
            updatedAt: "2026-05-22T00:00:01Z",
          },
        ],
        defaultBranch: "main",
      },
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["api", "repos/fankaidev/grovie/issues/3"],
      ["api", "repos/fankaidev/grovie"],
      ["api", "--paginate", "--slurp", "repos/fankaidev/grovie/issues/3/comments"],
    ]);
  });

  it("[UC-DAEMON-02-S03] lists open issues by label and skips pull requests", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify([
          [
            {
              number: 8,
              title: "Run daemon",
              labels: [{ name: "grovie" }],
            },
            {
              number: 9,
              title: "A pull request",
              labels: [{ name: "grovie" }],
              pull_request: {},
            },
          ],
        ]),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.listOpenIssues("fankaidev/grovie", "grovie")).toEqual({
      ok: true,
      value: [
        {
          reference: {
            owner: "fankaidev",
            repo: "grovie",
            number: 8,
          },
          title: "Run daemon",
          labels: ["grovie"],
        },
      ],
    });
    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["api", "--paginate", "--slurp", "repos/fankaidev/grovie/issues?state=open&labels=grovie"],
        input: undefined,
      },
    ]);
  });

  it("[UC-DAEMON-02-S13] rejects invalid repository names when listing issues", () => {
    const gateway = new GhGitHubGateway(new FakeRunner([]));

    expect(gateway.listOpenIssues("fankaidev/grovie/extra", "grovie")).toEqual({
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: 'Invalid repository "fankaidev/grovie/extra". Expected owner/repo.',
      },
    });
  });

  it("[UC-AGENT-02-S01] [UC-AGENT-02-S02] adds and removes labels through gh api", () => {
    const runner = new FakeRunner([{ stdout: "[]" }, { stdout: "" }]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.addLabels({ owner: "fankaidev", repo: "grovie", number: 3 }, ["in-progress"])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(gateway.removeLabel({ owner: "fankaidev", repo: "grovie", number: 3 }, "in-progress")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["api", "-X", "POST", "repos/fankaidev/grovie/issues/3/labels", "--input", "-"],
        input: `${JSON.stringify({ labels: ["in-progress"] })}\n`,
      },
      {
        command: "gh",
        args: ["api", "-X", "DELETE", "repos/fankaidev/grovie/issues/3/labels/in-progress"],
        input: undefined,
      },
    ]);
  });

  it("[UC-GITHUB-01-S01] [UC-GITHUB-01-S06] creates and updates issue comments", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          id: 10,
          body: "created",
          html_url: "https://github.com/fankaidev/grovie/issues/3#issuecomment-10",
        }),
      },
      {
        stdout: JSON.stringify({
          id: 10,
          body: "updated",
          html_url: "https://github.com/fankaidev/grovie/issues/3#issuecomment-10",
        }),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.createIssueComment({ owner: "fankaidev", repo: "grovie", number: 3 }, "created")).toEqual({
      ok: true,
      value: {
        id: 10,
        body: "created",
        url: "https://github.com/fankaidev/grovie/issues/3#issuecomment-10",
      },
    });
    expect(gateway.updateIssueComment("fankaidev/grovie", 10, "updated")).toEqual({
      ok: true,
      value: {
        id: 10,
        body: "updated",
        url: "https://github.com/fankaidev/grovie/issues/3#issuecomment-10",
      },
    });
  });

  it("[UC-RUN-03-S02] creates pull requests through gh api", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({ number: 14, html_url: "https://github.com/fankaidev/grovie/pull/14" }),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(
      gateway.createPullRequest({
        repository: "fankaidev/grovie",
        title: "feat: add gateway",
        body: "Closes #4",
        head: "issue-4",
        base: "main",
        draft: false,
      }),
    ).toEqual({
      ok: true,
      value: {
        number: 14,
        url: "https://github.com/fankaidev/grovie/pull/14",
      },
    });
    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: ["api", "-X", "POST", "repos/fankaidev/grovie/pulls", "--input", "-"],
      input: `${JSON.stringify({
        title: "feat: add gateway",
        body: "Closes #4",
        head: "issue-4",
        base: "main",
        draft: false,
      })}\n`,
    });
  });

  it("[UC-GITHUB-02-S01] discovers related pull requests by branch and issue references", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify([
          [
            {
              number: 20,
              title: "Implement result handling",
              state: "open",
              html_url: "https://github.com/fankaidev/grovie/pull/20",
              body: "Closes #9",
              updated_at: "2026-05-22T00:00:04Z",
              base: { ref: "main" },
              head: { ref: "grovie/fankaidev-grovie-issue-9-coder-fankai-mac", sha: "abc123" },
            },
            {
              number: 21,
              title: "Unrelated issue 99 branch",
              state: "open",
              html_url: "https://github.com/fankaidev/grovie/pull/21",
              body: "No issue link.",
              updated_at: "2026-05-22T00:00:04Z",
              base: { ref: "main" },
              head: { ref: "grovie/fankaidev-grovie-issue-99-coder-fankai-mac", sha: "def456" },
            },
            {
              number: 22,
              title: "Unrelated issue 90 branch",
              state: "open",
              html_url: "https://github.com/fankaidev/grovie/pull/22",
              body: "No issue link.",
              updated_at: "2026-05-22T00:00:04Z",
              base: { ref: "main" },
              head: { ref: "grovie/fankaidev-grovie-issue-90-coder-fankai-mac", sha: "def789" },
            },
          ],
        ]),
      },
      {
        stdout: JSON.stringify({
          mergeable_state: "dirty",
        }),
      },
      {
        stdout: JSON.stringify([[
          {
            id: 10,
            body: "Please update tests.",
            user: { login: "reviewer" },
            created_at: "2026-05-22T00:00:05Z",
            updated_at: "2026-05-22T00:00:05Z",
          },
        ]]),
      },
      {
        stdout: JSON.stringify([[
          {
            id: 11,
            body: "src/run.ts",
            user: { login: "reviewer" },
            created_at: "2026-05-22T00:00:06Z",
            updated_at: "2026-05-22T00:00:06Z",
          },
        ]]),
      },
      {
        stdout: JSON.stringify([[
          {
            id: 12,
            state: "APPROVED",
            body: "Looks good.",
            user: { login: "reviewer" },
            submitted_at: "2026-05-22T00:00:07Z",
          },
        ]]),
      },
      {
        stdout: JSON.stringify({
          total_count: 2,
          check_runs: [{ conclusion: "success" }, { conclusion: null }],
        }),
      },
      {
        stdout: "src/run.ts\ntests/run.test.ts\n",
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.readRelatedPullRequests({ owner: "fankaidev", repo: "grovie", number: 9 })).toEqual({
      ok: true,
      value: [
        {
          number: 20,
          title: "Implement result handling",
          state: "open",
          mergeStateStatus: "DIRTY",
          url: "https://github.com/fankaidev/grovie/pull/20",
          body: "Closes #9",
          baseRef: "main",
          headRef: "grovie/fankaidev-grovie-issue-9-coder-fankai-mac",
          headSha: "abc123",
          updatedAt: "2026-05-22T00:00:04Z",
          comments: [
            {
              id: 10,
              body: "Please update tests.",
              author: "reviewer",
              createdAt: "2026-05-22T00:00:05Z",
              updatedAt: "2026-05-22T00:00:05Z",
            },
          ],
          reviewComments: [
            {
              id: 11,
              body: "src/run.ts",
              author: "reviewer",
              createdAt: "2026-05-22T00:00:06Z",
              updatedAt: "2026-05-22T00:00:06Z",
            },
          ],
          reviews: [
            {
              id: 12,
              state: "APPROVED",
              author: "reviewer",
              body: "Looks good.",
              submittedAt: "2026-05-22T00:00:07Z",
            },
          ],
          checks: {
            totalCount: 2,
            conclusionCounts: {
              pending: 1,
              success: 1,
            },
          },
          diffSummary: "src/run.ts\ntests/run.test.ts",
        },
      ],
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["api", "--paginate", "--slurp", "repos/fankaidev/grovie/pulls?state=all&per_page=100"],
      ["api", "repos/fankaidev/grovie/pulls/20"],
      ["api", "--paginate", "--slurp", "repos/fankaidev/grovie/issues/20/comments"],
      ["api", "--paginate", "--slurp", "repos/fankaidev/grovie/pulls/20/comments"],
      ["api", "--paginate", "--slurp", "repos/fankaidev/grovie/pulls/20/reviews"],
      ["api", "repos/fankaidev/grovie/commits/abc123/check-runs"],
      ["pr", "diff", "20", "--repo", "fankaidev/grovie", "--name-only"],
    ]);
  });

  it("[UC-DAEMON-02-S15] lists repository events through gh", () => {
    const runner = new FakeRunner([
      {
        stdout: [
          "HTTP/2.0 200 OK",
          "Etag: W/\"events-etag\"",
          "X-Poll-Interval: 60",
          "",
          JSON.stringify([
            {
              id: "event-1",
              type: "IssueCommentEvent",
              created_at: "2026-05-24T12:49:36Z",
              actor: { login: "fankaidev" },
              payload: {
                action: "created",
                issue: {
                  number: 127,
                  html_url: "https://github.com/fankaidev/grovie/pull/127",
                },
                comment: {
                  html_url: "https://github.com/fankaidev/grovie/pull/127#issuecomment-1",
                },
              },
            },
          ]),
        ].join("\n"),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.listRepositoryEvents("fankaidev/grovie")).toEqual({
      ok: true,
      value: {
        status: "modified",
        etag: "W/\"events-etag\"",
        pollIntervalSeconds: 60,
        events: [
          {
            id: "event-1",
            type: "IssueCommentEvent",
            createdAt: "2026-05-24T12:49:36Z",
            actor: "fankaidev",
            action: "created",
            issueNumber: 127,
            issueUrl: "https://github.com/fankaidev/grovie/pull/127",
            commentUrl: "https://github.com/fankaidev/grovie/pull/127#issuecomment-1",
          },
        ],
      },
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["api", "-i", "repos/fankaidev/grovie/events?per_page=100"],
    ]);
  });

  it("[UC-DAEMON-02-S18] sends repository event ETags and handles unmodified responses", () => {
    const runner = new FakeRunner([
      {
        exitCode: 1,
        stdout: [
          "HTTP/2.0 304 Not Modified",
          "Etag: \"events-etag\"",
          "X-Poll-Interval: 60",
          "",
        ].join("\n"),
        stderr: "gh: HTTP 304",
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.listRepositoryEvents("fankaidev/grovie", { ifNoneMatch: "W/\"events-etag\"" })).toEqual({
      ok: true,
      value: {
        status: "not-modified",
        etag: "\"events-etag\"",
        pollIntervalSeconds: 60,
      },
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["api", "-i", "-H", "If-None-Match: W/\"events-etag\"", "repos/fankaidev/grovie/events?per_page=100"],
    ]);
  });

  it("[UC-DAEMON-02-S15] resolves pull request issue links from closing references, body, and branch", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                body: "Closes #8 and mentions #9",
                headRefName: "grovie/fankaidev-grovie-issue-10-coco-kai-mini",
                closingIssuesReferences: {
                  nodes: [{ number: 7 }],
                },
              },
            },
          },
        }),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.readPullRequestIssueLinks("fankaidev/grovie", 127)).toEqual({
      ok: true,
      value: [
        { pullRequestNumber: 127, issueNumber: 7, source: "closing-reference" },
        { pullRequestNumber: 127, issueNumber: 8, source: "body" },
        { pullRequestNumber: 127, issueNumber: 9, source: "body" },
        { pullRequestNumber: 127, issueNumber: 10, source: "branch" },
      ],
    });
    expect(runner.calls[0]?.args.slice(0, 2)).toEqual(["api", "graphql"]);
  });

  it("[UC-AGENT-01-S06] returns structured errors when gh fails", () => {
    const gateway = new GhGitHubGateway(
      new FakeRunner([
        {
          exitCode: 1,
          stderr: "not authenticated",
        },
      ]),
    );

    expect(gateway.getAuthenticatedUser()).toEqual({
      ok: false,
      error: {
        code: "gh_failed",
        message: "not authenticated",
        command: "gh api user",
        exitCode: 1,
        stderr: "not authenticated",
      },
    });
  });

  it("[UC-DAEMON-01-S10] lists recent repositories through gh repo list", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify([
          {
            nameWithOwner: "fankaidev/grovie",
            isPrivate: false,
            updatedAt: "2026-05-27T14:17:06Z",
          },
          {
            nameWithOwner: "fankaidev/qstory",
            isPrivate: true,
            updatedAt: "2026-05-23T01:22:59Z",
          },
        ]),
      },
    ]);
    const gateway = new GhGitHubGateway(runner);

    expect(gateway.listRecentRepositories(2)).toEqual({
      ok: true,
      value: [
        {
          repository: "fankaidev/grovie",
          private: false,
          updatedAt: "2026-05-27T14:17:06Z",
        },
        {
          repository: "fankaidev/qstory",
          private: true,
          updatedAt: "2026-05-23T01:22:59Z",
        },
      ],
    });
    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["repo", "list", "--limit", "2", "--json", "nameWithOwner,isPrivate,updatedAt"],
        input: undefined,
      },
    ]);
  });
});

describe("SpawnCommandRunner", () => {
  it("applies command timeouts", () => {
    const runner = new SpawnCommandRunner({ timeoutMs: 10 });
    const result = runner.run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ETIMEDOUT");
  });
});

type FakeCall = {
  command: string;
  args: string[];
  input: string | undefined;
};

class FakeRunner implements CommandRunner {
  readonly calls: FakeCall[] = [];

  constructor(private readonly results: Array<Partial<CommandResult>>) {}

  run(command: string, args: string[], input?: string): CommandResult {
    this.calls.push({ command, args, input });
    const result = this.results.shift();

    if (result === undefined) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}
