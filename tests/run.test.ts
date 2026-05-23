import { describe, expect, it } from "vitest";
import type { GrovieConfig } from "../src/config.js";
import type {
  CreatedComment,
  GitHubGateway,
  GitHubIssue,
  GitHubRelatedPullRequest,
  IssueReference,
} from "../src/github.js";
import type { LocalStatePaths, PreparedRun } from "../src/local-state.js";
import { runIssue, runIssueAsync, type RunLocalState } from "../src/run.js";
import type { HandleRunResultResult, ResultHandler } from "../src/result.js";
import type { AgentRunInput, AgentRuntime, RuntimeAvailability, RuntimeRunResult } from "../src/runtime.js";

describe("runIssue", () => {
  it("[UC-GITHUB-01-S01] [UC-GITHUB-02-S04] [UC-EXECUTION-05-S01] runs an allowed issue and posts a concise success comment", () => {
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
      repository: "fankaidev/grovie",
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
        "Session status: succeeded",
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
    expect(github.comments[0]).toContain("Grovie session succeeded.");
    expect(github.comments[0]).toContain('<!-- grovie:session {"runId":"fankaidev-grovie-issue-7","status":"succeeded","runtime":"codex"} -->');
    expect(github.comments[0]).toContain("- Session status: succeeded");
    expect(github.comments[0]).toContain("- Agent: `codex`");
    expect(github.comments[0]).toContain("- Machine: `");
    expect(github.comments[0]).toContain("- Changes: none");
    expect(github.comments[0]).toContain("- Branch: `grovie/issue-7` (local; not pushed)");
    expect(github.comments[0]).not.toContain("Prompt will be generated");
    expect(github.comments[0]).not.toContain("raw log");
    expect(localState.events.map((event) => event.type)).toEqual([
      "run.started",
      "result.handled",
      "run.succeeded",
      "comment.created",
    ]);
  });

  it("[UC-GITHUB-01-S01] [UC-GITHUB-01-S04] posts a concise failure comment when the runtime fails", () => {
    const github = new FakeGitHub();
    const localState = new FakeLocalState();
    const runtime = new FakeRuntime({
      ok: false,
      execution: fakeExecution(localState.run, 2),
      error: {
        message: [
          "raw stderr line 1",
          "raw stderr line 2",
          "raw stdout line 1",
        ].join("\n"),
      },
    });

    const result = runIssue({
      issueReference: {
        owner: "fankaidev",
        repo: "grovie",
        number: 7,
      },
      repository: "fankaidev/grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("raw stderr line 1\nraw stderr line 2\nraw stdout line 1");
    expect(result.stdout).toContain("Session status: failed");
    expect(github.comments[0]).toContain("Grovie session failed.");
    expect(github.comments[0]).toContain('<!-- grovie:session {"runId":"fankaidev-grovie-issue-7","status":"failed","runtime":"codex"} -->');
    expect(github.comments[0]).toContain("- Error: Runtime failed. See the local run directory for stdout and stderr.");
    expect(github.comments[0]).not.toContain("raw stderr line 1");
    expect(github.comments[0]).not.toContain("raw stdout line 1");
    expect(localState.events.map((event) => event.type)).toEqual(["run.started", "run.failed", "comment.created"]);
  });

  it("[UC-EXECUTION-05-S05] posts reviewer no-change output without opening a PR", () => {
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
      repository: "fankaidev/grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      agentId: "reviewer@fankai-mac",
      github,
      localState,
      runtime,
      resultHandler: new FakeResultHandler({
        kind: "no-changes",
        status: "",
        validationSummary: "Review approved: the implementation matches the issue intent.",
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Changes: none");
    expect(github.comments[0]).toContain("- Agent: `reviewer@fankai-mac`");
    expect(github.comments[0]).toContain("- Machine: `fankai-mac`");
    expect(github.comments[0]).toContain("- Changes: none");
    expect(github.comments[0]).toContain("- Review output: Review approved: the implementation matches the issue intent.");
    expect(github.comments[0]).not.toContain("- Pull request:");
  });

  it("[UC-GITHUB-01-S02] includes pull request output when result handling creates one", () => {
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
      repository: "fankaidev/grovie",
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

  it("[UC-EXECUTION-02-S09] includes retry trace metadata in the prepared run context", () => {
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
      repository: "fankaidev/grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
      runRequest: {
        sourceRunId: "failed-run",
        reason: "retry",
      },
      resultHandler: new FakeResultHandler({
        kind: "no-changes",
        status: "",
        validationSummary: "No validation output captured.",
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(localState.prepareInput?.runRequest).toEqual({
      sourceRunId: "failed-run",
      reason: "retry",
    });
    expect(localState.prepareInput?.task).toMatchObject({
      runRequest: {
        sourceRunId: "failed-run",
        reason: "retry",
      },
    });
  });

  it("[UC-GITHUB-02-S03] includes related pull request context in the local handoff", () => {
    const github = new FakeGitHub({
      relatedPullRequests: [
        fakeRelatedPullRequest(),
      ],
    });
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
      repository: "fankaidev/grovie",
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

    expect(result.exitCode).toBe(0);
    expect(localState.prepareInput?.task).toMatchObject({
      relatedPullRequests: [
        {
          number: 20,
          title: "Implement result handling",
          state: "open",
          baseRef: "main",
          headRef: "grovie/issue-7",
          headSha: "abc123",
          checks: {
            totalCount: 1,
            conclusionCounts: {
              success: 1,
            },
          },
          reviews: [
            {
              state: "APPROVED",
              author: "reviewer",
            },
          ],
          comments: [
            {
              body: "Please add BDD coverage.",
            },
          ],
          reviewComments: [
            {
              body: "tests/run.test.ts",
            },
          ],
          diffSummary: "tests/run.test.ts | 10 ++++++++++",
        },
      ],
    });
  });

  it("[UC-GITHUB-01-S04] marks the session failed when result handling fails after a successful runtime", () => {
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
      repository: "fankaidev/grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
      resultHandler: {
        handle: () => {
          throw new Error("pull request failed");
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("pull request failed");
    expect(result.stdout).toContain("Session status: failed");
    expect(github.comments[0]).toContain("Grovie session failed.");
    expect(localState.events.map((event) => event.type)).toEqual([
      "run.started",
      "result.failed",
      "run.failed",
      "comment.created",
    ]);
  });

  it("[UC-GITHUB-01-S01] posts a canceled comment when the async runtime is canceled", async () => {
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
      repository: "fankaidev/grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
      localState,
      runtime,
    });

    expect(result.exitCode).toBe(0);
    expect(result.canceled).toBe(true);
    expect(result.stdout).toContain("Session status: canceled");
    expect(github.comments[0]).toContain("Grovie session canceled.");
    expect(localState.events.map((event) => event.type)).toEqual(["run.started", "run.canceled", "comment.created"]);
  });

  it("[UC-GITHUB-01-S01] posts a failure comment with the deterministic run directory when preparation fails", () => {
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
      repository: "fankaidev/grovie",
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
    expect(github.comments[0]).toContain("Grovie session failed.");
    expect(github.comments[0]).toContain("- Error: git clone failed");
  });

  it("rejects issue references that do not match the runner repository before reading from GitHub", () => {
    const github = new FakeGitHub();

    const result = runIssue({
      issueReference: {
        owner: "other",
        repo: "repo",
        number: 7,
      },
      repository: "fankaidev/grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      agent: "codex",
      github,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "Issue repository other/repo does not match runner repository fankaidev/grovie.",
    });
    expect(github.reads).toBe(0);
  });
});

class FakeGitHub implements GitHubGateway {
  readonly comments: string[] = [];
  reads = 0;

  constructor(private readonly options: {
    relatedPullRequests?: GitHubRelatedPullRequest[];
  } = {}) {}

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

  readRelatedPullRequests(): ReturnType<NonNullable<GitHubGateway["readRelatedPullRequests"]>> {
    return {
      ok: true as const,
      value: this.options.relatedPullRequests ?? [],
    };
  }
}

class FakeLocalState implements RunLocalState {
  readonly paths: LocalStatePaths = {
    root: "/tmp/grovie",
    reposDir: "/tmp/grovie/repos",
    worktreesDir: "/tmp/grovie/worktrees",
    runsDir: "/tmp/grovie/runs",
    agentsDir: "/tmp/grovie/agents",
    locksDir: "/tmp/grovie/locks",
    requestsDir: "/tmp/grovie/requests",
    sessionsDir: "/tmp/grovie/sessions",
  };
  readonly run: PreparedRun = {
    sessionId: "fankaidev-grovie-issue-7-codex",
    runId: "fankaidev-grovie-issue-7",
    agentId: "codex",
    branchName: "grovie/issue-7",
    sessionDir: "/tmp/grovie/sessions/fankaidev-grovie-issue-7-codex",
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

    return input.agentId === this.run.agentId ? this.run : { ...this.run, agentId: input.agentId };
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
    updatedAt: "2026-05-22T00:00:00Z",
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

function fakeRelatedPullRequest(): GitHubRelatedPullRequest {
  return {
    number: 20,
    title: "Implement result handling",
    state: "open",
    url: "https://github.com/fankaidev/grovie/pull/20",
    body: "Closes #7",
    baseRef: "main",
    headRef: "grovie/issue-7",
    headSha: "abc123",
    updatedAt: "2026-05-22T00:00:02Z",
    checks: {
      totalCount: 1,
      conclusionCounts: {
        success: 1,
      },
    },
    reviews: [
      {
        id: 3,
        state: "APPROVED",
        author: "reviewer",
        body: "Looks good.",
        submittedAt: "2026-05-22T00:00:05Z",
      },
    ],
    comments: [
      {
        id: 1,
        body: "Please add BDD coverage.",
        author: "reviewer",
        createdAt: "2026-05-22T00:00:03Z",
        updatedAt: "2026-05-22T00:00:03Z",
      },
    ],
    reviewComments: [
      {
        id: 2,
        body: "tests/run.test.ts",
        author: "reviewer",
        createdAt: "2026-05-22T00:00:04Z",
        updatedAt: "2026-05-22T00:00:04Z",
      },
    ],
    diffSummary: "tests/run.test.ts | 10 ++++++++++",
  };
}
