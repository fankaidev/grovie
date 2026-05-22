import { describe, expect, it } from "vitest";
import { GhGitHubGateway, type CommandResult, type CommandRunner, parseIssueReference } from "../src/github.js";

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
  it("detects the authenticated GitHub user through gh", () => {
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

  it("reads issue details, default branch, and comments", () => {
    const runner = new FakeRunner([
      {
        stdout: JSON.stringify({
          title: "Implement config",
          body: null,
          state: "open",
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
        state: "open",
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

  it("lists open issues by label and skips pull requests", () => {
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

  it("rejects invalid repository names when listing issues", () => {
    const gateway = new GhGitHubGateway(new FakeRunner([]));

    expect(gateway.listOpenIssues("fankaidev/grovie/extra", "grovie")).toEqual({
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: 'Invalid repository "fankaidev/grovie/extra". Expected owner/repo.',
      },
    });
  });

  it("adds and removes labels through gh api", () => {
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

  it("creates and updates issue comments", () => {
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

  it("creates pull requests through gh api", () => {
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

  it("returns structured errors when gh fails", () => {
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
