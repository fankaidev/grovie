import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrovieConfig } from "../src/config.js";
import type {
  CommandResult,
  CommandRunner,
  CreatePullRequestInput,
  CreatedComment,
  CreatedPullRequest,
  GitHubGateway,
  GitHubIssue,
  IssueReference,
} from "../src/github.js";
import type { PreparedRun } from "../src/local-state.js";
import { getIssueCommentArtifactPath, getResultArtifactPath } from "../src/run-artifacts.js";
import { GitResultHandler } from "../src/result.js";
import type { RuntimeExecution } from "../src/runtime.js";

describe("GitResultHandler", () => {
  it("[UC-RUN-03-S01] comments no changes without committing or opening a PR", () => {
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
        configPath: "/home/user/.grovie/config.yml",
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

  it("[UC-RUN-03-S12] rejects a tool write failure that produced no explicit result artifact", () => {
    const run = fakeFileBackedRun((preparedRun) => {
      writeFileSync(
        preparedRun.stderrPath,
        "ERROR codex_core::tools::router: error=patch rejected: writing outside of the project; rejected by user approval settings\n",
        "utf8",
      );
    });
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(() =>
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toThrow("Runtime reported a tool write rejection outside the project and produced no result artifact.");
    expect(github.comments).toHaveLength(0);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-GITHUB-01-S07] [UC-RUN-03-S02] commits changed files, pushes the Grovie branch, and opens a PR", () => {
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
      configPath: "/home/user/.grovie/config.yml",
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
    expect(github.pullRequests[0]?.body).toContain("- Agent: `coder@fankai-mac`");
    expect(github.pullRequests[0]?.body).toContain("## Validation");
    expect(github.pullRequests[0]?.body).toContain("No validation output captured.");
  });

  it("[UC-RUN-03-S06] publishes an issue comment artifact without relying on runtime GitHub auth", () => {
    const run = fakeRunWithIssueComment("My debugger and I broke up because it kept stopping at every little issue.");
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "issue-comment",
      status: "",
      validationSummary: "No validation output captured.",
      comment: {
        id: 1,
        body: [
          '<!-- grovie:agent-comment {"agentId":"coder@fankai-mac"} -->',
          "coder@fankai-mac:",
          "",
          "My debugger and I broke up because it kept stopping at every little issue.",
        ].join("\n"),
        url: "https://github.com/fankaidev/grovie/issues/9#issuecomment-1",
      },
    });
    expect(github.comments[0]).toContain("coder@fankai-mac:");
    expect(github.comments[0]).toContain("My debugger and I broke up because it kept stopping at every little issue.");
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-RUN-03-S13] publishes a valid issue comment artifact even when result.json contains an unsupported action", () => {
    const run = fakeFileBackedRun((preparedRun) => {
      writeFileSync(getIssueCommentArtifactPath(preparedRun), "3\n", "utf8");
      writeFileSync(getResultArtifactPath(preparedRun), `${JSON.stringify({
        schemaVersion: 1,
        action: "publish",
        reason: "The comment artifact contains the intended issue reply.",
      }, null, 2)}\n`, "utf8");
    });
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "pi",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "issue-comment",
      status: "",
      validationSummary: "No validation output captured.",
      comment: {
        id: 1,
        body: [
          '<!-- grovie:agent-comment {"agentId":"coder@fankai-mac"} -->',
          "coder@fankai-mac:",
          "",
          "3",
        ].join("\n"),
        url: "https://github.com/fankaidev/grovie/issues/9#issuecomment-1",
      },
    });
    expect(github.comments[0]).toContain("3");
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-RUN-03-S07] honors an explicit no-op result with a human-readable reason", () => {
    const run = fakeRunWithResult({
      schemaVersion: 1,
      action: "no-op",
      reason: "The requested behavior already exists.",
    });
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "no-changes",
      status: "",
      validationSummary: "No validation output captured.",
      action: "no-op",
      reason: "The requested behavior already exists.",
    });
    expect(github.comments).toHaveLength(0);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-RUN-03-S11] ignores stale worktree result artifacts from earlier runs", () => {
    const run = fakeFileBackedRun((preparedRun) => {
      writeFileSync(join(preparedRun.worktreePath, ".grovie", "issue-comment.md"), "stale comment\n", "utf8");
      writeFileSync(join(preparedRun.worktreePath, ".grovie", "result.json"), `${JSON.stringify({
        schemaVersion: 1,
        action: "comment",
        comment: {
          body: "stale result",
        },
      }, null, 2)}\n`, "utf8");
      writeFileSync(getResultArtifactPath(preparedRun), `${JSON.stringify({
        schemaVersion: 1,
        action: "no-op",
        reason: "The current run intentionally produced no comment.",
      }, null, 2)}\n`, "utf8");
    });
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "no-changes",
      status: "",
      validationSummary: "No validation output captured.",
      action: "no-op",
      reason: "The current run intentionally produced no comment.",
    });
    expect(github.comments).toHaveLength(0);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-RUN-03-S08] publishes a comment action from result.json", () => {
    const run = fakeRunWithResult({
      schemaVersion: 1,
      action: "comment",
      reason: "The issue needs a maintainer decision.",
      comment: {
        body: "Please confirm which runtime should own this behavior.",
      },
    });
    const runner = new FakeRunner([
      {
        stdout: "",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "issue-comment",
      status: "",
      validationSummary: "No validation output captured.",
      comment: {
        id: 1,
        body: [
          '<!-- grovie:agent-comment {"agentId":"coder@fankai-mac"} -->',
          "coder@fankai-mac:",
          "",
          "Please confirm which runtime should own this behavior.",
        ].join("\n"),
        url: "https://github.com/fankaidev/grovie/issues/9#issuecomment-1",
      },
      action: "comment",
      reason: "The issue needs a maintainer decision.",
    });
    expect(github.comments[0]).toContain("coder@fankai-mac:");
    expect(github.comments[0]).toContain("Please confirm which runtime should own this behavior.");
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-RUN-03-S09] includes an explicit code-change reason in the pull request body", () => {
    const run = fakeRunWithResult({
      schemaVersion: 1,
      action: "code-change",
      reason: "Implemented the requested result protocol.",
    });
    const runner = new FakeRunner([
      {
        stdout: " M src/result.ts\n",
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
      run,
      issue: fakeIssue(),
      config: defaultConfig(),
      configPath: "/home/user/.grovie/config.yml",
      repository: "fankaidev/grovie",
      runtime: "codex",
      execution: fakeExecution(),
    });

    expect(result).toMatchObject({
      kind: "pull-request",
      action: "code-change",
      reason: "Implemented the requested result protocol.",
    });
    expect(github.pullRequests[0]?.body).toContain("- Reason: Implemented the requested result protocol.");
  });

  it("[UC-RUN-03-S10] allows non-code-change result actions when worktree changes exist", () => {
    const run = fakeRunWithResult({
      schemaVersion: 1,
      action: "request-human",
      reason: "The issue needs product input.",
    });
    const runner = new FakeRunner([
      {
        stdout: " M src/result.ts\n",
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

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toMatchObject({
      kind: "pull-request",
      action: "request-human",
      reason: "The issue needs product input.",
      pullRequest: {
        url: "https://github.com/fankaidev/grovie/pull/20",
      },
    });
    expect(github.pullRequests).toHaveLength(1);
  });

  it("[UC-RUN-03-S14] publishes an issue comment and opens a PR when both artifacts and changes exist", () => {
    const run = fakeFileBackedRun((preparedRun) => {
      writeFileSync(getIssueCommentArtifactPath(preparedRun), "I reviewed the change and left a local fix.\n", "utf8");
    });
    const runner = new FakeRunner([
      {
        stdout: " M fast-sort.py\n",
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

    expect(
      handler.handle({
        run,
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toEqual({
      kind: "pull-request",
      status: " M fast-sort.py\n",
      validationSummary: "No validation output captured.",
      commitSha: "abc123",
      pullRequest: {
        number: 20,
        url: "https://github.com/fankaidev/grovie/pull/20",
      },
      comment: {
        id: 1,
        body: [
          '<!-- grovie:agent-comment {"agentId":"coder@fankai-mac"} -->',
          "coder@fankai-mac:",
          "",
          "I reviewed the change and left a local fix.",
        ].join("\n"),
        url: "https://github.com/fankaidev/grovie/issues/9#issuecomment-1",
      },
    });
    expect(github.comments[0]).toContain("I reviewed the change and left a local fix.");
    expect(github.pullRequests).toHaveLength(1);
  });

  it("[UC-RUN-03-S03] reports deterministic branch push conflicts without opening a PR", () => {
    const runner = new FakeRunner([
      {
        stdout: " M src/index.ts\n",
      },
      {},
      {},
      {},
      {
        exitCode: 1,
        stderr: "! [rejected] HEAD -> grovie/issue-9 (non-fast-forward)",
      },
    ]);
    const github = new FakeGitHub();
    const handler = new GitResultHandler(github, runner);

    expect(() =>
      handler.handle({
        run: fakeRun(),
        issue: fakeIssue(),
        config: defaultConfig(),
        configPath: "/home/user/.grovie/config.yml",
        repository: "fankaidev/grovie",
        runtime: "codex",
        execution: fakeExecution(),
      }),
    ).toThrow(
      [
        "Could not push result branch grovie/issue-9.",
        "Another Grovie worker may have already pushed this issue branch.",
        "Grovie will not force-push or overwrite remote work.",
        "! [rejected] HEAD -> grovie/issue-9 (non-fast-forward)",
      ].join(" "),
    );
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
    ]);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("[UC-RUN-03-S04] refuses to push the default branch", () => {
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
        configPath: "/home/user/.grovie/config.yml",
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
  readonly comments: string[] = [];

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

  createIssueComment(reference: IssueReference, body: string): ReturnType<GitHubGateway["createIssueComment"]> {
    this.comments.push(body);

    return {
      ok: true,
      value: {
        id: this.comments.length,
        body,
        url: `https://github.com/${reference.owner}/${reference.repo}/issues/${reference.number}#issuecomment-${this.comments.length}`,
      } satisfies CreatedComment,
    };
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
    queue: {
      label: "grovie",
    },
    branches: {
      prefix: "grovie/",
    },
    safety: {
      allowDefaultBranchPush: false,
    },
  };
}

function fakeRun(): PreparedRun {
  return {
    sessionId: "fankaidev-grovie-issue-9-codex",
    runId: "fankaidev-grovie-issue-9",
    agentId: "coder@fankai-mac",
    branchName: "grovie/issue-9",
    sessionDir: "/tmp/grovie/sessions/fankaidev-grovie-issue-9-codex",
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

function fakeRunWithIssueComment(comment: string): PreparedRun {
  return fakeFileBackedRun((run) => {
    writeFileSync(getIssueCommentArtifactPath(run), `${comment}\n`, "utf8");
  });
}

function fakeRunWithResult(result: Record<string, unknown>): PreparedRun {
  return fakeFileBackedRun((run) => {
    writeFileSync(getResultArtifactPath(run), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  });
}

function fakeFileBackedRun(writeArtifacts: (run: PreparedRun) => void): PreparedRun {
  const root = mkdtempSync(join(tmpdir(), "grovie-result-"));
  const runId = "fankaidev-grovie-issue-9";
  const runDir = join(root, "runs", runId);
  const run = {
    ...fakeRun(),
    sessionDir: join(root, "sessions", "fankaidev-grovie-issue-9-codex"),
    repositoryCachePath: join(root, "repos", "fankaidev-grovie.git"),
    worktreePath: join(root, "worktrees", "fankaidev-grovie-issue-9"),
    runDir,
    taskPath: join(runDir, "task.json"),
    promptPath: join(runDir, "prompt.md"),
    eventsPath: join(runDir, "events.jsonl"),
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
  };

  mkdirSync(join(run.worktreePath, ".grovie"), { recursive: true });
  mkdirSync(join(run.worktreePath, ".grovie", "runs", run.runId), { recursive: true });
  mkdirSync(run.runDir, { recursive: true });
  writeFileSync(run.stdoutPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  writeArtifacts(run);
  return run;
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
    author: "fankaidev",
    state: "open",
    updatedAt: "2026-05-22T00:00:00Z",
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
