import { describe, expect, it } from "vitest";
import type { GrovieConfig } from "../src/config.js";
import type {
  CreatedComment,
  GitHubGateway,
  GitHubIssue,
  IssueReference,
} from "../src/github.js";
import type { LocalStatePaths, PreparedRun } from "../src/local-state.js";
import { runIssue, runIssueAsync, type RunLocalState } from "../src/run.js";
import type { HandleRunResultResult, ResultHandler } from "../src/result.js";
import type { AgentRunInput, AgentRuntime, RuntimeAvailability, RuntimeRunResult } from "../src/runtime.js";

describe("runIssue", () => {
  it("runs an allowed issue and posts a success comment", () => {
    const github = new FakeGitHub();
    const localState = new FakeLocalState();
    const runtime = new FakeRuntime({
      ok: true,
      execution: fakeExecution(localState.run, 0),
    });

    const result = runIssue({
      issueReference: {
        owner: "fankaidev",
        repo: "grovie",
        number: 7,
      },
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
      resultHandler: new FakeResultHandler({
        kind: "no-changes",
        status: "",
        validationSummary: "No validation output captured.",
      }),
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        "grovie run",
        "",
        "Result: success",
        "Issue: fankaidev/grovie#7",
        "Branch: grovie/issue-7",
        "Run id: fankaidev-grovie-issue-7",
        "Run directory: /tmp/grovie/runs/fankaidev-grovie-issue-7",
        "Comment: https://github.com/fankaidev/grovie/issues/7#issuecomment-1",
        "Changes: none",
      ].join("\n"),
      stderr: undefined,
    });
    expect(localState.prepareInput).toMatchObject({
      repository: "fankaidev/grovie",
      issueNumber: 7,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      task: {
        schemaVersion: 1,
        runtime: "codex",
        repository: "fankaidev/grovie",
      },
    });
    expect(runtime.runInput?.run).toBe(localState.run);
    expect(github.comments[0]).toContain("Grovie run completed.");
    expect(github.comments[0]).toContain("- Changes: none");
    expect(github.comments[0]).toContain("- Branch: `grovie/issue-7` (local; not pushed)");
    expect(localState.events.map((event) => event.type)).toEqual([
      "run.started",
      "result.handled",
      "run.succeeded",
      "comment.created",
    ]);
  });

  it("posts a concise failure comment when the runtime fails", () => {
    const github = new FakeGitHub();
    const localState = new FakeLocalState();
    const runtime = new FakeRuntime({
      ok: false,
      execution: fakeExecution(localState.run, 2),
      error: {
        message: "codex failed",
      },
    });

    const result = runIssue({
      issueReference: {
        owner: "fankaidev",
        repo: "grovie",
        number: 7,
      },
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("codex failed");
    expect(result.stdout).toContain("Result: failure");
    expect(github.comments[0]).toContain("Grovie run failed.");
    expect(github.comments[0]).toContain("- Error: codex failed");
    expect(localState.events.map((event) => event.type)).toEqual(["run.started", "run.failed", "comment.created"]);
  });

  it("includes pull request output when result handling creates one", () => {
    const github = new FakeGitHub();
    const localState = new FakeLocalState();
    const runtime = new FakeRuntime({
      ok: true,
      execution: fakeExecution(localState.run, 0),
    });

    const result = runIssue({
      issueReference: {
        owner: "fankaidev",
        repo: "grovie",
        number: 7,
      },
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
      resultHandler: new FakeResultHandler({
        kind: "pull-request",
        status: " M src/index.ts\n",
        validationSummary: "pnpm check passed",
        commitSha: "abc123",
        pullRequest: {
          number: 20,
          url: "https://github.com/fankaidev/grovie/pull/20",
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Pull request: https://github.com/fankaidev/grovie/pull/20");
    expect(github.comments[0]).toContain("- Pull request: https://github.com/fankaidev/grovie/pull/20");
    expect(localState.events.map((event) => event.type)).toEqual([
      "run.started",
      "result.handled",
      "run.succeeded",
      "comment.created",
    ]);
  });

  it("posts a canceled comment when the async runtime is canceled", async () => {
    const github = new FakeGitHub();
    const localState = new FakeLocalState();
    const runtime = new FakeRuntime({
      ok: false,
      canceled: true,
      execution: {
        ...fakeExecution(localState.run, 130),
        canceled: true,
        signal: "SIGTERM",
      },
      error: {
        message: "Runtime canceled.",
      },
    });

    const result = await runIssueAsync({
      issueReference: {
        owner: "fankaidev",
        repo: "grovie",
        number: 7,
      },
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
    });

    expect(result.exitCode).toBe(0);
    expect(result.canceled).toBe(true);
    expect(result.stdout).toContain("Result: canceled");
    expect(github.comments[0]).toContain("Grovie run canceled.");
    expect(localState.events.map((event) => event.type)).toEqual(["run.started", "run.canceled", "comment.created"]);
  });

  it("posts a failure comment with the deterministic run directory when preparation fails", () => {
    const github = new FakeGitHub();
    const localState = new FakeLocalState({
      prepareError: new Error("git clone failed"),
    });

    const result = runIssue({
      issueReference: {
        owner: "fankaidev",
        repo: "grovie",
        number: 7,
      },
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime: new FakeRuntime({
        ok: true,
        execution: fakeExecution(localState.run, 0),
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("git clone failed");
    expect(result.stdout).toContain("Run directory: /tmp/grovie/runs/fankaidev-grovie-issue-7");
    expect(github.comments[0]).toContain("Grovie run failed.");
    expect(github.comments[0]).toContain("- Error: git clone failed");
  });

  it("rejects repositories outside the allowlist before reading from GitHub", () => {
    const github = new FakeGitHub();

    const result = runIssue({
      issueReference: {
        owner: "other",
        repo: "repo",
        number: 7,
      },
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "Repository other/repo is not allowed by /project/.grovie.yml.",
    });
    expect(github.reads).toBe(0);
  });
});

class FakeGitHub implements GitHubGateway {
  readonly comments: string[] = [];
  reads = 0;

  getAuthenticatedUser(): ReturnType<GitHubGateway["getAuthenticatedUser"]> {
    throw new Error("getAuthenticatedUser was not expected");
  }

  readIssue(reference: IssueReference): ReturnType<GitHubGateway["readIssue"]> {
    this.reads += 1;

    return {
      ok: true as const,
      value: fakeIssue(reference),
    };
  }

  listOpenIssues(): ReturnType<GitHubGateway["listOpenIssues"]> {
    throw new Error("listOpenIssues was not expected");
  }

  addLabels(
    _reference: IssueReference,
    _labels: string[],
  ): ReturnType<GitHubGateway["addLabels"]> {
    throw new Error("addLabels was not expected");
  }

  removeLabel(
    _reference: IssueReference,
    _label: string,
  ): ReturnType<GitHubGateway["removeLabel"]> {
    throw new Error("removeLabel was not expected");
  }

  createIssueComment(_reference: IssueReference, body: string): ReturnType<GitHubGateway["createIssueComment"]> {
    this.comments.push(body);

    return {
      ok: true as const,
      value: {
        id: this.comments.length,
        body,
        url: `https://github.com/fankaidev/grovie/issues/7#issuecomment-${this.comments.length}`,
      } satisfies CreatedComment,
    };
  }

  updateIssueComment(
    _repository: string,
    _commentId: number,
    _body: string,
  ): ReturnType<GitHubGateway["updateIssueComment"]> {
    throw new Error("updateIssueComment was not expected");
  }

  createPullRequest(_input: Parameters<GitHubGateway["createPullRequest"]>[0]): ReturnType<GitHubGateway["createPullRequest"]> {
    throw new Error("createPullRequest was not expected");
  }
}

class FakeLocalState implements RunLocalState {
  readonly paths: LocalStatePaths = {
    root: "/tmp/grovie",
    reposDir: "/tmp/grovie/repos",
    worktreesDir: "/tmp/grovie/worktrees",
    runsDir: "/tmp/grovie/runs",
  };
  readonly run: PreparedRun = {
    runId: "fankaidev-grovie-issue-7",
    branchName: "grovie/issue-7",
    repositoryCachePath: "/tmp/grovie/repos/fankaidev-grovie.git",
    worktreePath: "/tmp/grovie/worktrees/fankaidev-grovie-issue-7",
    runDir: "/tmp/grovie/runs/fankaidev-grovie-issue-7",
    taskPath: "/tmp/grovie/runs/fankaidev-grovie-issue-7/task.json",
    promptPath: "/tmp/grovie/runs/fankaidev-grovie-issue-7/prompt.md",
    eventsPath: "/tmp/grovie/runs/fankaidev-grovie-issue-7/events.jsonl",
    stdoutPath: "/tmp/grovie/runs/fankaidev-grovie-issue-7/stdout.log",
    stderrPath: "/tmp/grovie/runs/fankaidev-grovie-issue-7/stderr.log",
  };
  readonly events: Array<{ type: string; data: Record<string, unknown> | undefined }> = [];
  prepareInput: Parameters<RunLocalState["prepareRun"]>[0] | undefined;

  constructor(private readonly options: { prepareError?: Error } = {}) {}

  getPaths(): LocalStatePaths {
    return this.paths;
  }

  prepareRun(input: Parameters<RunLocalState["prepareRun"]>[0]): PreparedRun {
    this.prepareInput = input;

    if (this.options.prepareError !== undefined) {
      throw this.options.prepareError;
    }

    return this.run;
  }

  appendEvent(_run: PreparedRun, type: string, data?: Record<string, unknown>): void {
    this.events.push({ type, data });
  }
}

class FakeRuntime implements AgentRuntime {
  readonly name = "codex";
  runInput: AgentRunInput | undefined;

  constructor(private readonly result: RuntimeRunResult) {}

  checkAvailability(): RuntimeAvailability {
    return {
      runtime: "codex",
      command: "codex",
      available: true,
      version: "codex-cli 0.133.0",
      message: "available (codex-cli 0.133.0)",
    };
  }

  run(input: AgentRunInput): RuntimeRunResult {
    this.runInput = input;
    return this.result;
  }
}

class FakeResultHandler implements ResultHandler {
  constructor(private readonly result: HandleRunResultResult) {}

  handle(): HandleRunResultResult {
    return this.result;
  }
}

function defaultConfig(): GrovieConfig {
  return {
    version: 1,
    repositories: {
      allowed: ["fankaidev/grovie"],
    },
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

function fakeIssue(reference: IssueReference): GitHubIssue {
  return {
    reference,
    title: "Implement one-shot run",
    body: "Run this issue once.",
    state: "open",
    labels: ["mvp", "type:task"],
    comments: [
      {
        id: 1,
        body: "Keep it lightweight.",
        author: "fankaidev",
        createdAt: "2026-05-22T00:00:00Z",
        updatedAt: "2026-05-22T00:00:00Z",
      },
    ],
    defaultBranch: "main",
  };
}

function fakeExecution(run: PreparedRun, exitCode: number) {
  return {
    runtime: "codex" as const,
    command: ["codex", "exec"],
    startedAt: "2026-05-22T00:00:00Z",
    endedAt: "2026-05-22T00:00:01Z",
    exitCode,
    promptPath: run.promptPath,
    taskPath: run.taskPath,
    worktreePromptPath: `${run.worktreePath}/.grovie/prompt.md`,
    worktreeTaskPath: `${run.worktreePath}/.grovie/task.json`,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
  };
}
