import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, renderHelp, runCli, runCliAsync } from "../src/cli-app.js";
import { type AgentMetadata, resolveMachineId } from "../src/identity.js";
import { GROVIE_VERSION } from "../src/version.js";
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
  it("[UC-WORKER-03-S01] registers the issue assignment command", () => {
    expect(commands.map((command) => command.name)).toEqual(["init", "doctor", "status", "runs", "issue", "run", "daemon", "watch"]);
  });

  it("renders help with the MVP commands", () => {
    const help = renderHelp();

    expect(help).toContain("grovie <command>");
    expect(help).toContain("-v, --version");
    expect(help).toContain("init");
    expect(help).toContain("doctor");
    expect(help).toContain("status");
    expect(help).toContain("runs");
    expect(help).toContain("run");
    expect(help).toContain("daemon");
    expect(help).toContain("watch");
  });

  it("accepts pnpm script argument separators", () => {
    expect(runCli(["--", "--help"])).toEqual({
      exitCode: 0,
      stdout: renderHelp(),
    });
  });

  it("reports the package version through long and short flags", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

    expect(GROVIE_VERSION).toBe(packageVersion.version);
    expect(runCli(["--version"])).toEqual({
      exitCode: 0,
      stdout: "0.1.0",
    });
    expect(runCli(["-v"])).toEqual({
      exitCode: 0,
      stdout: "0.1.0",
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

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState: new FakeLocalState(createTmpDir()) })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Invalid .grovie.yml:"),
    });
  });

  it("rejects unknown config fields through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });
    writeFileSync(join(cwd, ".grovie.yml"), `${readFileSync(join(cwd, ".grovie.yml"), "utf8")}unsupported: true\n`, "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState: new FakeLocalState(createTmpDir()) })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Unrecognized key: \"unsupported\""),
    });
  });

  it("[UC-WORKER-01-S04] validates the default local agent through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "",
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Local policy config: ${join(cwd, ".grovie.yml")} is valid.`,
        `Machine id: ${machineId}`,
        `Default agent: default@${machineId} (codex)`,
        "Default runtime: codex",
        "Queue label: grovie",
        "GitHub: authenticated as fankaidev.",
        "Codex: available (codex-cli 0.133.0).",
      ].join("\n"),
    });
    expect(localState.registeredAgents).toEqual([
      expect.objectContaining({
        agentId: `default@${machineId}`,
        machineId,
        runtime: "codex",
        envKeys: ["OPENAI_API_KEY"],
      }),
    ]);
  });

  it("[UC-WORKER-01-S04] [UC-EXECUTION-03-S02] reports unavailable Codex runtime through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });
    const globalRoot = createTmpDir();
    const machineId = resolveMachineId(hostname());

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway(),
        localState: new FakeLocalState(globalRoot),
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
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Local policy config: ${join(cwd, ".grovie.yml")} is valid.`,
        `Machine id: ${machineId}`,
        `Default agent: default@${machineId} (codex)`,
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
        localState: new FakeLocalState(createTmpDir()),
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "gh auth required",
    });
  });

  it("shows active and recent local runs through status", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    writeLocalRun(localState.paths.runsDir, "active-run", {
      metadata: {
        runId: "active-run",
        repository: "fankaidev/grovie",
        issueNumber: 36,
        branchName: "grovie/issue-36",
        worktreePath: "/tmp/grovie/worktrees/active-run",
      },
      events: [
        {
          timestamp: "2999-05-23T10:00:00.000Z",
          type: "runtime.started",
          data: {
            runtime: "codex",
          },
        },
      ],
    });

    const result = runCli(["status"], { cwd, localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("grovie status");
    expect(result.stdout).toContain("- active-run");
    expect(result.stdout).toContain("Status: running");
    expect(result.stdout).toContain("Issue: fankaidev/grovie#36");
    expect(result.stdout).toContain(`Logs: stdout=${join(localState.paths.runsDir, "active-run", "stdout.log")}`);
  });

  it("lists and shows local runs through runs subcommands", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    writeLocalRun(localState.paths.runsDir, "failed-run", {
      metadata: {
        runId: "failed-run",
        repository: "fankaidev/grovie",
        issueNumber: 37,
        branchName: "grovie/issue-37",
        localBranchName: "grovie/issue-37-attempt",
        worktreePath: "/tmp/grovie/worktrees/failed-run",
      },
      events: [
        {
          timestamp: "2026-05-23T10:00:00.000Z",
          type: "runtime.started",
          data: {
            runtime: "codex",
          },
        },
        {
          timestamp: "2026-05-23T10:01:00.000Z",
          type: "run.failed",
          data: {
            exitCode: 1,
          },
        },
      ],
    });

    expect(runCli(["runs", "list"], { cwd, localState }).stdout).toContain("Status: failed");

    const detail = runCli(["runs", "show", "failed-run"], { cwd, localState });

    expect(detail.exitCode).toBe(0);
    expect(detail.stdout).toContain("grovie runs show");
    expect(detail.stdout).toContain("Run id: failed-run");
    expect(detail.stdout).toContain("Local branch: grovie/issue-37-attempt");
    expect(detail.stdout).toContain(`Stderr log: ${join(localState.paths.runsDir, "failed-run", "stderr.log")}`);
    expect(detail.stdout).toContain('run.failed {"exitCode":1}');
  });

  it("requires a run id for runs show", () => {
    expect(runCli(["runs", "show"])).toEqual({
      exitCode: 1,
      stderr: "Missing run id. Usage: grovie runs show <run-id>",
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

  it("accepts the issue reference after options without reading cwd repository identity", async () => {
    const cwd = createTmpDir();

    const result = await runCliAsync(["run", "--agent", "codex", "other/repo#2"], {
      cwd,
      github: fakeGitHubGateway({
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            comments: [
              {
                id: 42,
                body: '<!-- grovie:claim {"workerId":"other-worker","status":"active"} -->\nGrovie daemon task claim active.',
                author: "fankaidev",
                createdAt: "2026-05-23T00:00:00Z",
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      }),
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: [
        "Issue other/repo#2 already has an active Grovie claim.",
        "Claim owner: other-worker.",
        "Claim comment: 42.",
      ].join(" "),
    });
  });

  it("rejects unsupported run agents", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    expect(runCli(["run", "fankaidev/grovie#2", "--agent", "claude"], { cwd })).toEqual({
      exitCode: 1,
      stderr: "Unsupported agent runtime: claude. Only codex is supported.",
    });
  });

  it("[UC-WORKER-03-S04] runs manual issue execution for an agent id without adding assignment labels", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState();
    let runtimeInput: AgentRunInput | undefined;
    const issueComments: GitHubIssue["comments"] = [];
    writeInvalidPolicyConfig(cwd);

    const result = await runCliAsync(["run", "fankaidev/grovie#2", "--agent", "coder@fankai-mac"], {
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
    expect(result.stdout).toContain("Session status: failed");
    expect(runtimeInput?.run).toBe(localState.run);
    expect(issueComments[0]?.body).toContain("Grovie run task claim released.");
    expect(issueComments[0]?.body).toContain("- Worker: `coder@fankai-mac`");
    expect(issueComments[0]?.body).toContain("- Note: Session failed. See the Grovie result comment and local run logs.");
    expect(issueComments[1]?.body).toContain("Grovie session failed.");
    expect(issueComments[1]?.body).toContain('<!-- grovie:session {"runId":"fankaidev-grovie-issue-2","status":"failed","runtime":"codex"} -->');
  });

  it("does not start manual issue execution when another active claim owns the issue", async () => {
    const cwd = createTmpDir();
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
                body: '<!-- grovie:claim {"workerId":"other-worker","status":"active"} -->\nGrovie daemon task claim active.',
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

  it("[UC-WORKER-01-S05] runs one daemon polling cycle from global watched repositories and records default agent metadata", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeInvalidPolicyConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    expect(
      await runCliAsync(["daemon", "--label", "grovie", "--once"], {
        cwd,
        localState,
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
    expect(localState.registeredAgents).toEqual([
      expect.objectContaining({
        agentId: expect.stringMatching(/^default@.+/),
        runtime: "codex",
        envKeys: ["OPENAI_API_KEY"],
      }),
    ]);
  });

  it("[UC-WORKER-03-S01] assigns an issue to an agent label", () => {
    const addedLabels: Array<{ reference: IssueReference; labels: string[] }> = [];

    expect(
      runCli(["issue", "assign", "fankaidev/grovie#123", "coder@fankai-mac"], {
        github: fakeGitHubGateway({
          addLabels: (reference, labels) => {
            addedLabels.push({ reference, labels });
            return {
              ok: true,
              value: undefined,
            };
          },
        }),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie issue assign",
        "",
        "Added agent:coder@fankai-mac to fankaidev/grovie#123.",
      ].join("\n"),
    });
    expect(addedLabels).toEqual([
      {
        reference: {
          owner: "fankaidev",
          repo: "grovie",
          number: 123,
        },
        labels: ["agent:coder@fankai-mac"],
      },
    ]);
  });

  it("[UC-WORKER-03-S02] unassigns only the matching agent label", () => {
    const removedLabels: Array<{ reference: IssueReference; label: string }> = [];

    expect(
      runCli(["issue", "unassign", "fankaidev/grovie#123", "coder@fankai-mac"], {
        github: fakeGitHubGateway({
          removeLabel: (reference, label) => {
            removedLabels.push({ reference, label });
            return {
              ok: true,
              value: undefined,
            };
          },
        }),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie issue unassign",
        "",
        "Removed agent:coder@fankai-mac from fankaidev/grovie#123.",
      ].join("\n"),
    });
    expect(removedLabels).toEqual([
      {
        reference: {
          owner: "fankaidev",
          repo: "grovie",
          number: 123,
        },
        label: "agent:coder@fankai-mac",
      },
    ]);
  });

  it("uses built-in queue defaults for global daemon without reading cwd policy config", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeInvalidPolicyConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    expect(
      await runCliAsync(["daemon", "--once"], {
        cwd,
        localState,
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

  it("runs an explicit daemon repository without reading the current checkout repository", async () => {
    const cwd = createTmpDir();
    writeInvalidPolicyConfig(cwd);

    expect(
      await runCliAsync(["daemon", "--repo", "fankaidev/other", "--label", "ready", "--once"], {
        cwd,
        github: fakeGitHubGateway({
          listOpenIssues: (repository, label) => {
            expect(repository).toBe("fankaidev/other");
            expect(label).toBe("ready");

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
        "No queued issues found for fankaidev/other with label ready.",
      ].join("\n"),
    });
  });

  it("manages watched repositories in the global config", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);

    expect(runCli(["watch", "add", "fankaidev/grovie", "--label", "ready"], { cwd, localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie watch add",
        "",
        "Added fankaidev/grovie.",
        `Config: ${join(globalRoot, "config.yml")}`,
      ].join("\n"),
    });

    expect(runCli(["watch", "list"], { cwd, localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie watch list",
        "",
        `Config: ${join(globalRoot, "config.yml")}`,
        "- fankaidev/grovie label=ready",
      ].join("\n"),
    });

    expect(runCli(["watch", "remove", "fankaidev/grovie"], { cwd, localState }).stdout).toContain("Removed fankaidev/grovie.");
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeInvalidPolicyConfig(cwd: string): void {
  writeFileSync(join(cwd, ".grovie.yml"), "version: 1\nunsupported: true\n", "utf8");
}

function writeLocalRun(
  runsDir: string,
  runId: string,
  input: {
    metadata: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  },
): void {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), input.events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
  writeFileSync(join(runDir, "stdout.log"), "", "utf8");
  writeFileSync(join(runDir, "stderr.log"), "", "utf8");
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
  readonly paths: LocalStatePaths;
  readonly registeredAgents: AgentMetadata[] = [];
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

  constructor(root = "/tmp/grovie") {
    this.paths = {
      root,
      reposDir: `${root}/repos`,
      worktreesDir: `${root}/worktrees`,
      runsDir: `${root}/runs`,
      agentsDir: `${root}/agents`,
      locksDir: `${root}/locks`,
      sessionsDir: `${root}/sessions`,
    };
  }

  getPaths(): LocalStatePaths {
    return this.paths;
  }

  prepareRun(): PreparedRun {
    return this.run;
  }

  appendEvent(): void {}

  registerAgent(metadata: AgentMetadata): void {
    this.registeredAgents.push(metadata);
  }
}

function fakeIssue(reference: IssueReference): GitHubIssue {
  return {
    reference,
    title: "Stream runtime output",
    body: "Make runtime logs visible while Codex runs.",
    state: "open",
    updatedAt: "2026-05-22T00:00:00Z",
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
