import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, renderHelp, runCli, runCliAsync } from "../src/cli-app.js";
import type { CreatedComment, GitHubGateway, GitHubIssue, IssueReference } from "../src/github.js";
import type { LocalStatePaths, PreparedRun } from "../src/local-state.js";
import type { RunLocalState } from "../src/run.js";
import type { AgentRunInput, AgentRuntime, RuntimeAvailability } from "../src/runtime.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI command registration", () => {
  it("registers the MVP command set", () => {
    expect(commands.map((command) => command.name)).toEqual(["init", "doctor", "run", "daemon"]);
  });

  it("renders help with the MVP commands", () => {
    const help = renderHelp();

    expect(help).toContain("grovie <command>");
    expect(help).toContain("init");
    expect(help).toContain("doctor");
    expect(help).toContain("run");
    expect(help).toContain("daemon");
  });

  it("accepts pnpm script argument separators", () => {
    expect(runCli(["--", "--help"])).toEqual({
      exitCode: 0,
      stdout: renderHelp(),
    });
  });

  it("writes the default policy config", () => {
    const cwd = createTmpDir();

    expect(runCli(["init"], { cwd })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie init",
        "",
        "Created .grovie.yml.",
        "Run `grovie doctor` to validate it.",
      ].join("\n"),
    });

    expect(readFileSync(join(cwd, ".grovie.yml"), "utf8")).not.toContain("repository:");
  });

  it("reports invalid config fields through doctor", () => {
    const cwd = createTmpDir();
    writeFileSync(join(cwd, ".grovie.yml"), "version: 1\nsafety:\n  allowDefaultBranchPush: true\n", "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime() })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Invalid .grovie.yml:"),
    });
  });

  it("rejects unknown config fields through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });
    writeFileSync(join(cwd, ".grovie.yml"), `${readFileSync(join(cwd, ".grovie.yml"), "utf8")}unsupported: true\n`, "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime() })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Unrecognized key: \"unsupported\""),
    });
  });

  it("validates the default config through doctor", () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime() })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "",
        `Config: ${join(cwd, ".grovie.yml")} is valid.`,
        "Repository: fankaidev/grovie",
        "Default runtime: codex",
        "Queue label: grovie",
        "GitHub: authenticated as fankaidev.",
        "Codex: available (codex-cli 0.133.0).",
      ].join("\n"),
    });
  });

  it("reports unavailable Codex runtime through doctor", () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway(),
        runtime: fakeRuntime({
          available: false,
          message: "codex command not found",
        }),
      }),
    ).toEqual({
      exitCode: 1,
      stdout: [
        "grovie doctor",
        "",
        `Config: ${join(cwd, ".grovie.yml")} is valid.`,
        "Repository: fankaidev/grovie",
        "Default runtime: codex",
        "Queue label: grovie",
        "GitHub: authenticated as fankaidev.",
        "Codex: codex command not found.",
      ].join("\n"),
      stderr: "Codex runtime is not available. Install the Codex CLI or choose another runtime when one is supported.",
    });
  });

  it("reports GitHub authentication errors through doctor", () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway({
          getAuthenticatedUser: () => ({
            ok: false,
            error: {
              code: "gh_failed",
              message: "gh auth required",
            },
          }),
        }),
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "gh auth required",
    });
  });

  it("requires an issue reference for run", () => {
    expect(runCli(["run"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
    });
  });

  it("does not treat option values as issue references", () => {
    expect(runCli(["run", "--agent", "codex"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
    });
  });

  it("rejects malformed issue references with extra path segments", () => {
    expect(runCli(["run", "fankaidev/grovie/extra#2"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
    });
  });

  it("accepts the issue reference after options", () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);

    const result = runCli(["run", "--agent", "codex", "other/repo#2"], { cwd });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "Repository other/repo does not match current checkout repository fankaidev/grovie.",
    });
  });

  it("rejects unsupported run agents", () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    expect(runCli(["run", "fankaidev/grovie#2", "--agent", "claude"], { cwd })).toEqual({
      exitCode: 1,
      stderr: "Unsupported agent runtime: claude. Only codex is supported.",
    });
  });

  it("runs manual issue execution through the async runtime path", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState();
    let runtimeInput: AgentRunInput | undefined;
    const issueComments: GitHubIssue["comments"] = [];
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    const result = await runCliAsync(["run", "fankaidev/grovie#2", "--agent", "codex"], {
      cwd,
      github: fakeGitHubGateway({
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            comments: [...issueComments],
          },
        }),
        createIssueComment: (_reference, body) => {
          const comment = addIssueComment(issueComments, body);

          return {
            ok: true,
            value: comment,
          };
        },
        updateIssueComment: (_repository, commentId, body) => {
          const comment = issueComments.find((candidate) => candidate.id === commentId);

          if (comment !== undefined) {
            comment.body = body;
            comment.updatedAt = "2026-05-23T00:00:01Z";
          }

          return {
            ok: true,
            value: {
              id: commentId,
              body,
              url: `https://github.com/fankaidev/grovie/issues/2#issuecomment-${commentId}`,
            } satisfies CreatedComment,
          };
        },
      }),
      localState,
      runtime: {
        name: "codex",
        checkAvailability: fakeRuntime().checkAvailability,
        run: () => {
          throw new Error("sync runtime path was not expected");
        },
        runAsync: (input) => {
          runtimeInput = input;

          return Promise.resolve({
            ok: false,
            execution: fakeExecution(localState.run, 2),
            error: {
              message: "async runtime failed",
            },
          });
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("async runtime failed");
    expect(result.stdout).toContain("Result: failure");
    expect(runtimeInput?.run).toBe(localState.run);
    expect(issueComments[0]?.body).toContain("Grovie run failed.");
    expect(issueComments[1]?.body).toContain("Grovie run failed.");
  });

  it("does not start manual issue execution when another active claim owns the issue", async () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    const result = await runCliAsync(["run", "fankaidev/grovie#2", "--agent", "codex"], {
      cwd,
      github: fakeGitHubGateway({
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            comments: [
              {
                id: 42,
                body: '<!-- grovie:claim {"workerId":"other-worker","status":"running"} -->\nGrovie daemon running.',
                author: "fankaidev",
                createdAt: "2026-05-23T00:00:00Z",
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      }),
      runtime: {
        ...fakeRuntime(),
        runAsync: () => {
          throw new Error("runtime run was not expected");
        },
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: [
        "Issue fankaidev/grovie#2 already has an active Grovie claim.",
        "Claim owner: other-worker.",
        "Claim comment: 42.",
      ].join(" "),
    });
  });

  it("runs one daemon polling cycle with the current checkout repository and explicit label", async () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    expect(
      await runCliAsync(["daemon", "--label", "grovie", "--once"], {
        cwd,
        github: fakeGitHubGateway({
          listOpenIssues: (repository, label) => {
            expect(repository).toBe("fankaidev/grovie");
            expect(label).toBe("grovie");

            return {
              ok: true,
              value: [],
            };
          },
        }),
        runtime: fakeRuntime(),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
      ].join("\n"),
    });
  });

  it("rejects daemon repository options that do not match the current checkout repository", async () => {
    const cwd = createTmpDir();
    initGitHubOrigin(cwd);
    runCli(["init"], { cwd });

    expect(
      await runCliAsync(["daemon", "--repo", "fankaidev/other", "--label", "ready", "--once"], {
        cwd,
        github: fakeGitHubGateway(),
        runtime: fakeRuntime(),
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "Repository fankaidev/other does not match current checkout repository fankaidev/grovie.",
    });
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-test-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitHubOrigin(cwd: string): void {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:fankaidev/grovie.git"], { cwd, stdio: "ignore" });
}

function fakeRuntime(availability: Partial<RuntimeAvailability> = {}): AgentRuntime {
  return {
    name: "codex",
    checkAvailability: () => ({
      runtime: "codex",
      command: "codex",
      available: true,
      version: "codex-cli 0.133.0",
      message: "available (codex-cli 0.133.0)",
      ...availability,
    }),
    run: () => {
      throw new Error("runtime run was not expected");
    },
  };
}

function fakeGitHubGateway(overrides: Partial<GitHubGateway> = {}): GitHubGateway {
  return {
    getAuthenticatedUser: () => ({
      ok: true,
      value: {
        login: "fankaidev",
      },
    }),
    readIssue: () => {
      throw new Error("readIssue was not expected");
    },
    listOpenIssues: () => {
      throw new Error("listOpenIssues was not expected");
    },
    addLabels: () => {
      throw new Error("addLabels was not expected");
    },
    removeLabel: () => {
      throw new Error("removeLabel was not expected");
    },
    createIssueComment: () => {
      throw new Error("createIssueComment was not expected");
    },
    updateIssueComment: () => {
      throw new Error("updateIssueComment was not expected");
    },
    createPullRequest: () => {
      throw new Error("createPullRequest was not expected");
    },
    ...overrides,
  };
}

class FakeLocalState implements RunLocalState {
  readonly paths: LocalStatePaths = {
    root: "/tmp/grovie",
    reposDir: "/tmp/grovie/repos",
    worktreesDir: "/tmp/grovie/worktrees",
    runsDir: "/tmp/grovie/runs",
  };
  readonly run: PreparedRun = {
    runId: "fankaidev-grovie-issue-2",
    branchName: "grovie/issue-2",
    repositoryCachePath: "/tmp/grovie/repos/fankaidev-grovie.git",
    worktreePath: "/tmp/grovie/worktrees/fankaidev-grovie-issue-2",
    runDir: "/tmp/grovie/runs/fankaidev-grovie-issue-2",
    taskPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/task.json",
    promptPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/prompt.md",
    eventsPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/events.jsonl",
    stdoutPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/stdout.log",
    stderrPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/stderr.log",
  };

  getPaths(): LocalStatePaths {
    return this.paths;
  }

  prepareRun(): PreparedRun {
    return this.run;
  }

  appendEvent(): void {}
}

function fakeIssue(reference: IssueReference): GitHubIssue {
  return {
    reference,
    title: "Stream runtime output",
    body: "Make runtime logs visible while Codex runs.",
    state: "open",
    labels: ["mvp", "type:task"],
    comments: [],
    defaultBranch: "main",
  };
}

function addIssueComment(comments: GitHubIssue["comments"], body: string): CreatedComment {
  const id = comments.length + 1;
  const timestamp = new Date().toISOString();

  comments.push({
    id,
    body,
    author: "fankaidev",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    id,
    body,
    url: `https://github.com/fankaidev/grovie/issues/2#issuecomment-${id}`,
  };
}

function fakeExecution(run: PreparedRun, exitCode: number) {
  return {
    runtime: "codex" as const,
    command: ["codex", "exec"],
    startedAt: "2026-05-23T00:00:00Z",
    endedAt: "2026-05-23T00:00:01Z",
    exitCode,
    promptPath: run.promptPath,
    taskPath: run.taskPath,
    worktreePromptPath: `${run.worktreePath}/.grovie/prompt.md`,
    worktreeTaskPath: `${run.worktreePath}/.grovie/task.json`,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
  };
}
