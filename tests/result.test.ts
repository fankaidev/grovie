import { describe, expect, it } from "vitest";
import type { GrovieConfig } from "../src/config.js";
import type {
  CommandResult,
  CommandRunner,
  CreatePullRequestInput,
  CreatedPullRequest,
  GitHubGateway,
  GitHubIssue,
  IssueReference,
} from "../src/github.js";
import type { PreparedRun } from "../src/local-state.js";
import { GitResultHandler } from "../src/result.js";
import type { RuntimeExecution } from "../src/runtime.js";

describe("GitResultHandler", () => {
  it("comments no changes without committing or opening a PR", () => {
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(
      handler.handle({
        run: fakeRun(),
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/project/.grovie.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "no-changes",
      status: "",
      validationSummary: "No validation output captured.",
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["status", "--short", "--", ".", ":(exclude).grovie"],
    ]);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("commits changed files, pushes the Grovie branch, and opens a PR", () => {
    const runner = new FakeRunner([
      {
        stdout: " M src/index.ts\n",
      },
      {},
      {},
      {},
      {},
      {
        stdout: "abc123\n",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    const result = handler.handle({
      run: fakeRun(),
      issue: fakeIssue(),
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      repository: "fankaidev/grovie",
      runtime: "codex",
      execution: fakeExecution(),
    });

    expect(result).toEqual({
      kind: "pull-request",
      status: " M src/index.ts\n",
      validationSummary: "No validation output captured.",
      commitSha: "abc123",
      pullRequest: {
        number: 20,
        url: "https://github.com/fankaidev/grovie/pull/20",
      },
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["status", "--short", "--", ".", ":(exclude).grovie"],
      ["add", "--all", "--", ".", ":(exclude).grovie"],
      ["restore", "--staged", "--", ".grovie"],
      [
        "commit",
        "-m",
        "grovie: Implement result handling",
        "-m",
        "Source issue: fankaidev/grovie#9",
        "-m",
        "Run id: fankaidev-grovie-issue-9",
      ],
      ["push", "-u", "origin", "HEAD:grovie/issue-9"],
      ["rev-parse", "HEAD"],
    ]);
    expect(github.pullRequests[0]).toMatchObject({
      repository: "fankaidev/grovie",
      title: "grovie: Implement result handling",
      head: "grovie/issue-9",
      base: "main",
      draft: false,
    });
    expect(github.pullRequests[0]?.body).toContain("Closes #9");
    expect(github.pullRequests[0]?.body).toContain("- Source issue: fankaidev/grovie#9");
    expect(github.pullRequests[0]?.body).toContain("- Run id: fankaidev-grovie-issue-9");
    expect(github.pullRequests[0]?.body).toContain("- Runtime: codex");
    expect(github.pullRequests[0]?.body).toContain("## Validation");
    expect(github.pullRequests[0]?.body).toContain("No validation output captured.");
  });

  it("refuses to push the default branch", () => {
    const runner = new FakeRunner([]);
    const handler = new GitResultHandler(new FakeGitHub(), runner);

    expect(() =>
      handler.handle({
        run: {
          ...fakeRun(),
          branchName: "main",
        },
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/project/.grovie.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toThrow("Refusing to push default branch main.");
    expect(runner.calls).toHaveLength(0);
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

class FakeGitHub implements GitHubGateway {
  readonly pullRequests: CreatePullRequestInput[] = [];

  getAuthenticatedUser(): ReturnType<GitHubGateway["getAuthenticatedUser"]> {
    throw new Error("getAuthenticatedUser was not expected");
  }

  listOpenIssues(): ReturnType<GitHubGateway["listOpenIssues"]> {
    throw new Error("listOpenIssues was not expected");
  }

  readIssue(): ReturnType<GitHubGateway["readIssue"]> {
    throw new Error("readIssue was not expected");
  }

  addLabels(): ReturnType<GitHubGateway["addLabels"]> {
    throw new Error("addLabels was not expected");
  }

  removeLabel(): ReturnType<GitHubGateway["removeLabel"]> {
    throw new Error("removeLabel was not expected");
  }

  createIssueComment(): ReturnType<GitHubGateway["createIssueComment"]> {
    throw new Error("createIssueComment was not expected");
  }

  updateIssueComment(): ReturnType<GitHubGateway["updateIssueComment"]> {
    throw new Error("updateIssueComment was not expected");
  }

  createPullRequest(input: CreatePullRequestInput): ReturnType<GitHubGateway["createPullRequest"]> {
    this.pullRequests.push(input);

    return {
      ok: true,
      value: {
        number: 20,
        url: "https://github.com/fankaidev/grovie/pull/20",
      } satisfies CreatedPullRequest,
    };
  }
}

function defaultConfig(): GrovieConfig {
  return {
    version: 1,
    runtime: {
      default: "codex",
    },
    queue: {
      label: "grovie",
    },
    branches: {
      prefix: "grovie/",
    },
    worktrees: {
      cleanup: "on-success",
    },
    pullRequests: {
      create: true,
      draft: false,
    },
    comments: {
      mode: "concise",
    },
    safety: {
      allowDefaultBranchPush: false,
    },
  };
}

function fakeRun(): PreparedRun {
  return {
    runId: "fankaidev-grovie-issue-9",
    branchName: "grovie/issue-9",
    repositoryCachePath: "/tmp/grovie/repos/fankaidev-grovie.git",
    worktreePath: "/tmp/grovie/worktrees/fankaidev-grovie-issue-9",
    runDir: "/tmp/grovie/runs/fankaidev-grovie-issue-9",
    taskPath: "/tmp/grovie/runs/fankaidev-grovie-issue-9/task.json",
    promptPath: "/tmp/grovie/runs/fankaidev-grovie-issue-9/prompt.md",
    eventsPath: "/tmp/grovie/runs/fankaidev-grovie-issue-9/events.jsonl",
    stdoutPath: "/tmp/grovie/runs/fankaidev-grovie-issue-9/stdout.log",
    stderrPath: "/tmp/grovie/runs/fankaidev-grovie-issue-9/stderr.log",
  };
}

function fakeIssue(): GitHubIssue {
  return {
    reference: {
      owner: "fankaidev",
      repo: "grovie",
      number: 9,
    },
    title: "Implement result handling",
    body: "Push the branch and open a PR.",
    state: "open",
    labels: ["mvp"],
    comments: [],
    defaultBranch: "main",
  };
}

function fakeExecution(): RuntimeExecution {
  const run = fakeRun();

  return {
    runtime: "codex",
    command: ["codex", "exec"],
    startedAt: "2026-05-22T00:00:00Z",
    endedAt: "2026-05-22T00:00:01Z",
    exitCode: 0,
    promptPath: run.promptPath,
    taskPath: run.taskPath,
    worktreePromptPath: `${run.worktreePath}/.grovie/prompt.md`,
    worktreeTaskPath: `${run.worktreePath}/.grovie/task.json`,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
  };
}
