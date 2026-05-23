import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBranchName, buildLocalBranchName, buildRunId, LocalState } from "../src/local-state.js";
import type { CommandResult, CommandRunner } from "../src/github.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local state paths", () => {
  it("builds attempt-specific run ids and deterministic result branch names", () => {
    expect(buildRunId("fankaidev/grovie", 5, "attempt-a")).toBe("fankaidev-grovie-issue-5-attempt-a");
    expect(buildRunId("fankaidev/grovie", 5)).toMatch(/^fankaidev-grovie-issue-5-\d{14}-[0-9a-f]{8}$/);
    expect(buildBranchName("grovie/", 5)).toBe("grovie/issue-5");
    expect(buildBranchName("grovie", 5)).toBe("grovie/issue-5");
    expect(buildLocalBranchName("grovie/", 5, "attempt-a")).toBe("grovie/issue-5-attempt-a");
  });
});

describe("LocalState", () => {
  it("[UC-WORKER-01-S05] records agent registry metadata without environment values", () => {
    const root = createTmpDir();
    const state = new LocalState({ paths: { root }, runner: new FakeRunner() });

    state.registerAgent({
      agentId: "default@fankai-mac",
      name: "default",
      machineId: "fankai-mac",
      runtime: "codex",
      args: ["--model", "gpt-5.3-codex"],
      envKeys: ["OPENAI_API_KEY"],
    });

    const metadata = JSON.parse(readFileSync(join(root, "agents", "default-fankai-mac.json"), "utf8")) as Record<string, unknown>;

    expect(metadata).toEqual({
      agentId: "default@fankai-mac",
      name: "default",
      machineId: "fankai-mac",
      runtime: "codex",
      args: ["--model", "gpt-5.3-codex"],
      envKeys: ["OPENAI_API_KEY"],
    });
    expect(JSON.stringify(metadata)).not.toContain("secret");
  });

  it("[UC-WORKER-04-S01] refuses a second live daemon lock for the same machine", () => {
    const state = new LocalState({ paths: { root: createTmpDir() }, runner: new FakeRunner() });
    const first = state.acquireDaemonLock("fankai-mac", new Date("2026-05-23T00:00:00Z"));
    const second = state.acquireDaemonLock("fankai-mac", new Date("2026-05-23T00:00:01Z"));

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      message: `Grovie daemon already appears to be running for machine fankai-mac with pid ${process.pid}.`,
    });
  });

  it("[UC-WORKER-04-S02] recovers a stale daemon lock", () => {
    const root = createTmpDir();
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(
      join(root, "locks", "daemon-fankai-mac.json"),
      `${JSON.stringify({
        machineId: "fankai-mac",
        pid: -1,
        acquiredAt: "2026-05-23T00:00:00Z",
        path: join(root, "locks", "daemon-fankai-mac.json"),
      })}\n`,
      "utf8",
    );

    const state = new LocalState({ paths: { root }, runner: new FakeRunner() });
    const result = state.acquireDaemonLock("fankai-mac", new Date("2026-05-23T00:00:01Z"));

    expect(result.ok).toBe(true);
    expect(result.ok ? result.recoveredStale : false).toBe(true);
  });

  it("[UC-WORKER-04-S05] blocks duplicate local execution locks for the same issue and agent", () => {
    const state = new LocalState({ paths: { root: createTmpDir() }, runner: new FakeRunner() });
    const first = state.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "default@fankai-mac",
      now: new Date("2026-05-23T00:00:00Z"),
    });
    const second = state.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "default@fankai-mac",
      now: new Date("2026-05-23T00:00:01Z"),
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      message: "Grovie execution already appears active for fankaidev/grovie#8 and default@fankai-mac.",
    });
  });

  it("[UC-WORKER-04-S06] allows different agents to hold independent execution locks on one issue", () => {
    const state = new LocalState({ paths: { root: createTmpDir() }, runner: new FakeRunner() });

    expect(state.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "coder@fankai-mac",
    }).ok).toBe(true);
    expect(state.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "reviewer@fankai-mac",
    }).ok).toBe(true);
  });

  it("creates repo cache, worktree, and run artifacts without touching the checkout", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    const run = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      attemptId: "attempt-a",
      task: {
        issue: 5,
      },
      prompt: "Implement issue #5",
    });

    expect(run.runId).toBe("fankaidev-grovie-issue-5-attempt-a");
    expect(run.branchName).toBe("grovie/issue-5");
    expect(readFileSync(run.taskPath, "utf8")).toContain('"issue": 5');
    expect(readFileSync(run.promptPath, "utf8")).toBe("Implement issue #5");
    expect(existsSync(run.stdoutPath)).toBe(true);
    expect(existsSync(run.stderrPath)).toBe(true);
    expect(readFileSync(run.eventsPath, "utf8")).toContain('"type":"prepared"');
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["clone", "--bare", "https://github.com/fankaidev/grovie.git", join(root, "repos", "fankaidev-grovie.git")],
      [
        "-C",
        join(root, "repos", "fankaidev-grovie.git"),
        "fetch",
        "origin",
        "+refs/heads/main:refs/heads/main",
      ],
      ["-C", join(root, "repos", "fankaidev-grovie.git"), "worktree", "prune"],
      ["-C", join(root, "repos", "fankaidev-grovie.git"), "branch", "-D", "grovie/issue-5-attempt-a"],
      [
        "-C",
        join(root, "repos", "fankaidev-grovie.git"),
        "worktree",
        "add",
        "-B",
        "grovie/issue-5-attempt-a",
        join(root, "worktrees", "fankaidev-grovie-issue-5-attempt-a"),
        "main",
      ],
    ]);
  });

  it("fetches existing caches and recreates existing worktree paths", () => {
    const root = createTmpDir();
    const cachePath = join(root, "repos", "fankaidev-grovie.git");
    const worktreePath = join(root, "worktrees", "fankaidev-grovie-issue-5-attempt-a");
    mkdirSync(cachePath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      attemptId: "attempt-a",
      task: {},
      prompt: "",
    });

    expect(existsSync(worktreePath)).toBe(false);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-C", cachePath, "fetch", "origin", "+refs/heads/main:refs/heads/main"],
      ["-C", cachePath, "worktree", "remove", "--force", worktreePath],
      ["-C", cachePath, "worktree", "prune"],
      ["-C", cachePath, "branch", "-D", "grovie/issue-5-attempt-a"],
      ["-C", cachePath, "worktree", "add", "-B", "grovie/issue-5-attempt-a", worktreePath, "main"],
    ]);
  });

  it("uses unique local worktrees for repeated attempts while keeping the result branch fixed", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    const first = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      attemptId: "attempt-a",
      task: {},
      prompt: "",
    });
    const second = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      attemptId: "attempt-b",
      task: {},
      prompt: "",
    });

    expect(first.branchName).toBe("grovie/issue-5");
    expect(second.branchName).toBe("grovie/issue-5");
    expect(first.runId).not.toBe(second.runId);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.worktreePath).toContain("attempt-a");
    expect(second.worktreePath).toContain("attempt-b");
  });

  it("cleans successful worktrees without deleting run logs", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });
    const run = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      attemptId: "attempt-a",
      task: {},
      prompt: "",
    });
    mkdirSync(run.worktreePath, { recursive: true });

    state.cleanupSuccessfulWorktree(run);

    expect(existsSync(run.eventsPath)).toBe(true);
    expect(readFileSync(run.eventsPath, "utf8")).toContain('"type":"worktree.cleaned"');
    expect(runner.calls.at(-1)?.args).toEqual([
      "-C",
      run.repositoryCachePath,
      "worktree",
      "remove",
      "--force",
      run.worktreePath,
    ]);
  });

  it("preserves run artifacts when worktree preparation fails", () => {
    const root = createTmpDir();
    const runner = new FakeRunner({ failWorktreeAdd: true });
    const state = new LocalState({ paths: { root }, runner });

    expect(() =>
      state.prepareRun({
        repository: "fankaidev/grovie",
        issueNumber: 5,
        defaultBranch: "main",
        branchPrefix: "grovie/",
        attemptId: "attempt-a",
        task: {
          issue: 5,
        },
        prompt: "Implement issue #5",
      }),
    ).toThrow("fatal: invalid reference: main");

    const runDir = join(root, "runs", "fankaidev-grovie-issue-5-attempt-a");
    const eventsPath = join(runDir, "events.jsonl");

    expect(readFileSync(join(runDir, "task.json"), "utf8")).toContain('"issue": 5');
    expect(readFileSync(join(runDir, "prompt.md"), "utf8")).toBe("Implement issue #5");
    expect(existsSync(join(runDir, "stdout.log"))).toBe(true);
    expect(existsSync(join(runDir, "stderr.log"))).toBe(true);
    expect(readFileSync(eventsPath, "utf8")).toContain('"type":"prepare.failed"');
  });
});

type FakeCall = {
  command: string;
  args: string[];
  input: string | undefined;
};

class FakeRunner implements CommandRunner {
  readonly calls: FakeCall[] = [];

  constructor(private readonly options: { failWorktreeAdd?: boolean } = {}) {}

  run(command: string, args: string[], input?: string): CommandResult {
    this.calls.push({ command, args, input });

    if (this.options.failWorktreeAdd && args.includes("worktree") && args.includes("add")) {
      return {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: invalid reference: main",
      };
    }

    if (args.includes("worktree") && args.includes("remove")) {
      rmSync(args.at(-1) ?? "", { recursive: true, force: true });
    }

    if (args.includes("branch") && args.includes("-D")) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: branch 'grovie/issue-5' not found",
      };
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
}

function createTmpDir(): string {
  const dir = join(tmpdir(), `grovie-local-state-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
