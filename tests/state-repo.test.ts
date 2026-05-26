import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StateRepoConfig } from "../src/config.js";
import type { CommandResult, CommandRunner, GitHubGateway } from "../src/github.js";
import type { LocalStatePaths, PreparedRun } from "../src/local-state.js";
import {
  initStateRepository,
  projectStateRepoFiles,
  redactStateRepoText,
  syncStateRepository,
} from "../src/state-repo.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("state repo setup", () => {
  it("[UC-STATE-REPO-01-S01] creates a private default grovie-state repository", () => {
    const github = fakeGitHub({
      owners: ["fankaidev"],
      existing: false,
    });

    const result = initStateRepository({
      root: createTmpDir(),
      github,
    });

    expect(result).toMatchObject({
      repository: "fankaidev/grovie-state",
      branch: "main",
      syncIntervalSeconds: 60,
      created: true,
    });
    expect(github.created).toEqual([
      {
        repository: "fankaidev/grovie-state",
        private: true,
      },
    ]);
  });

  it("[UC-STATE-REPO-01-S02] asks for owner when multiple GitHub owners are available", () => {
    expect(() =>
      initStateRepository({
        root: createTmpDir(),
        github: fakeGitHub({
          owners: ["fankaidev", "example-org"],
          existing: false,
        }),
      })
    ).toThrow("Pass --owner");
  });
});

describe("state repo sync", () => {
  it("[UC-STATE-REPO-01-S03] [UC-STATE-REPO-01-S08] writes redacted relative machine, daemon, heartbeat, agent, session, and run files without issue content", () => {
    const root = createTmpDir();
    const paths = createPaths(root);
    const run = writeRun(paths);
    const repoPath = join(root, "state-repo");

    projectStateRepoFiles({
      config: stateRepoConfig(),
      paths,
      machineId: "fankai-mac",
      agentId: "default@fankai-mac",
      run,
      summary: {
        runDir: run.runDir,
        token: "ghp_secret1234567890",
      },
      now: new Date("2026-05-24T00:00:00Z"),
    });

    expect(existsSync(join(repoPath, "machines", "fankai-mac.json"))).toBe(true);
    expect(existsSync(join(repoPath, "daemons", "fankai-mac.json"))).toBe(true);
    expect(existsSync(join(repoPath, "heartbeats", "fankai-mac.json"))).toBe(true);
    expect(existsSync(join(repoPath, "agents", "default-fankai-mac.json"))).toBe(true);
    expect(readFileSync(join(repoPath, "runs", run.runId, "metadata.json"), "utf8")).toContain("runs/run-1");
    expect(readFileSync(join(repoPath, "runs", run.runId, "metadata.json"), "utf8")).not.toContain(root);
    const projectedPrompt = readFileSync(join(repoPath, "runs", run.runId, "prompt.md"), "utf8");
    expect(projectedPrompt).toContain("[omitted from state repo]");
    expect(projectedPrompt).not.toContain("secret issue body");
    expect(projectedPrompt).not.toContain("secret issue comment");
    expect(projectedPrompt).not.toContain("escaped issue body");
    expect(projectedPrompt).not.toContain("escaped issue comment");
    expect(readFileSync(join(repoPath, "runs", run.runId, "stdout.log"), "utf8")).toContain("password=[REDACTED]");
    expect(readFileSync(join(repoPath, "runs", run.runId, "summary.json"), "utf8")).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(existsSync(join(repoPath, "runs", run.runId, "task.json"))).toBe(false);
  });

  it("[UC-STATE-REPO-01-S04] commits one daemon batch per sync tick", () => {
    const root = createTmpDir();
    const paths = createPaths(root);
    const repoPath = join(root, "state-repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    const runner = new FakeRunner();

    const result = syncStateRepository({
      config: stateRepoConfig(),
      paths,
      machineId: "fankai-mac",
      runner,
      now: new Date("2026-05-24T00:00:00Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      committed: true,
    });
    expect(runner.commands.filter((command) => command.includes(" commit "))).toHaveLength(1);
    expect(runner.commands.filter((command) => command.includes(" push "))).toHaveLength(1);
  });

  it("[UC-STATE-REPO-01-S05] includes final run summary in a run completion sync", () => {
    const root = createTmpDir();
    const paths = createPaths(root);
    const repoPath = join(root, "state-repo");
    const run = writeRun(paths);

    projectStateRepoFiles({
      config: stateRepoConfig(),
      paths,
      machineId: "fankai-mac",
      agentId: "default@fankai-mac",
      run,
      summary: {
        status: "succeeded",
        runId: run.runId,
        resultKind: "no-changes",
      },
      now: new Date("2026-05-24T00:00:00Z"),
    });

    expect(JSON.parse(readFileSync(join(repoPath, "runs", run.runId, "summary.json"), "utf8"))).toEqual({
      status: "succeeded",
      runId: "run-1",
      resultKind: "no-changes",
    });
  });

  it("[UC-STATE-REPO-01-S06] pulls, rebases, and retries after a push conflict", () => {
    const root = createTmpDir();
    const paths = createPaths(root);
    const repoPath = join(root, "state-repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    const runner = new FakeRunner({
      pushFailures: 1,
    });

    const result = syncStateRepository({
      config: stateRepoConfig(),
      paths,
      machineId: "fankai-mac",
      runner,
      now: new Date("2026-05-24T00:00:00Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      committed: true,
    });
    expect(runner.commands).toContain("git -C " + repoPath + " pull --rebase origin main");
    expect(runner.commands.filter((command) => command.includes(" push "))).toHaveLength(2);
  });

  it("[UC-STATE-REPO-01-S07] marks sync pending when git sync fails", () => {
    const root = createTmpDir();
    const paths = createPaths(root);
    const repoPath = join(root, "state-repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });

    const result = syncStateRepository({
      config: stateRepoConfig(),
      paths,
      machineId: "fankai-mac",
      runner: new FakeRunner({
        failCommit: true,
      }),
      now: new Date("2026-05-24T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(join(repoPath, ".grovie-sync-pending.json"), "utf8")).toContain("pending");
  });

  it("[UC-STATE-REPO-01-S09] redacts common credential patterns", () => {
    const redacted = redactStateRepoText([
      "token: abc123",
      "password=hunter2",
      "Authorization: Bearer abc.def",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "DATABASE_URL=postgres://user:pass@example.com/db",
      "github_pat_abcdef0123456789",
    ].join("\n"));

    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).toContain("[REDACTED");
  });

  it("[UC-STATE-REPO-01-S10] records heartbeat as observability data, not a scheduling lock", () => {
    const root = createTmpDir();
    const paths = createPaths(root);
    const repoPath = join(root, "state-repo");

    projectStateRepoFiles({
      config: stateRepoConfig(),
      paths,
      machineId: "fankai-mac",
      now: new Date("2026-05-24T00:00:00Z"),
    });

    expect(JSON.parse(readFileSync(join(repoPath, "daemons", "fankai-mac.json"), "utf8"))).toMatchObject({
      machineId: "fankai-mac",
      heartbeatIsSchedulingLock: false,
    });
    expect(readFileSync(join(repoPath, "heartbeats", "fankai-mac.json"), "utf8")).toContain("observability data only");
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-state-repo-"));
  tmpDirs.push(dir);
  return dir;
}

function createPaths(root: string): LocalStatePaths {
  return {
    root,
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir: join(root, "runs"),
    locksDir: join(root, "locks"),
    sessionsDir: join(root, "sessions"),
  };
}

function stateRepoConfig(): StateRepoConfig {
  return {
    enabled: true,
    repository: "fankaidev/grovie-state",
    branch: "main",
    syncIntervalSeconds: 60,
  };
}

function writeRun(paths: LocalStatePaths): PreparedRun {
  const run: PreparedRun = {
    sessionId: "session-1",
    runId: "run-1",
    agentId: "default@fankai-mac",
    branchName: "grovie/issue-57",
    sessionDir: join(paths.sessionsDir, "session-1"),
    repositoryCachePath: join(paths.reposDir, "fankaidev-grovie.git"),
    worktreePath: join(paths.worktreesDir, "session-1"),
    runDir: join(paths.runsDir, "run-1"),
    taskPath: join(paths.runsDir, "run-1", "task.json"),
    promptPath: join(paths.runsDir, "run-1", "prompt.md"),
    eventsPath: join(paths.runsDir, "run-1", "events.jsonl"),
    stdoutPath: join(paths.runsDir, "run-1", "stdout.log"),
    stderrPath: join(paths.runsDir, "run-1", "stderr.log"),
  };

  mkdirSync(run.runDir, { recursive: true });
  mkdirSync(run.sessionDir, { recursive: true });
  writeFileSync(join(run.runDir, "metadata.json"), JSON.stringify({
    runId: run.runId,
    runDir: run.runDir,
    taskPath: run.taskPath,
  }), "utf8");
  writeFileSync(join(run.sessionDir, "session.json"), JSON.stringify({
    sessionId: run.sessionId,
    worktreePath: run.worktreePath,
  }), "utf8");
  writeFileSync(run.promptPath, [
    "Body:",
    "secret issue body",
    "",
    "Comments:",
    "secret issue comment",
    "",
    "Task JSON:",
    JSON.stringify({
      issue: {
        body: "escaped issue body with \"quote\" that regex redaction must not leak",
        comments: [
          {
            body: "escaped issue comment with \"quote\" that regex redaction must not leak",
          },
        ],
      },
    }, null, 2),
  ].join("\n"), "utf8");
  writeFileSync(run.stdoutPath, "password=hunter2\n", "utf8");
  writeFileSync(run.stderrPath, "Bearer abc.def\n", "utf8");
  writeFileSync(run.eventsPath, "{\"type\":\"run.started\"}\n", "utf8");
  writeFileSync(run.taskPath, "{\"issue\":{\"body\":\"secret issue body\"}}\n", "utf8");
  return run;
}

function fakeGitHub(input: { owners: string[]; existing: boolean }): GitHubGateway & { created: Array<{ repository: string; private: boolean }> } {
  const created: Array<{ repository: string; private: boolean }> = [];

  return {
    created,
    getAuthenticatedUser: () => ({
      ok: true,
      value: {
        login: input.owners[0] ?? "fankaidev",
      },
    }),
    listRepositoryOwners: () => ({
      ok: true,
      value: input.owners,
    }),
    readRepository: (repository) => input.existing
      ? {
        ok: true,
        value: {
          repository,
          private: true,
          url: `https://github.com/${repository}`,
        },
      }
      : {
        ok: false,
        error: {
          code: "gh_failed",
          message: "not found",
        },
      },
    createRepository: (request) => {
      created.push(request);
      return {
        ok: true,
        value: {
          repository: request.repository,
          private: request.private,
          url: `https://github.com/${request.repository}`,
        },
      };
    },
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
  };
}

class FakeRunner implements CommandRunner {
  readonly commands: string[] = [];
  private pushFailures: number;

  constructor(private readonly options: { pushFailures?: number; failCommit?: boolean } = {}) {
    this.pushFailures = options.pushFailures ?? 0;
  }

  run(command: string, args: string[]): CommandResult {
    this.commands.push([command, ...args].join(" "));

    if (args.includes("status")) {
      return result(" M machines/fankai-mac.json\n");
    }

    if (args.includes("commit") && this.options.failCommit === true) {
      return result("", "commit failed", 1);
    }

    if (args.includes("push") && this.pushFailures > 0) {
      this.pushFailures -= 1;
      return result("", "non-fast-forward", 1);
    }

    return result("");
  }
}

function result(stdout: string, stderr = "", exitCode = 0): CommandResult {
  return {
    exitCode,
    stdout,
    stderr,
  };
}
