import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBranchName, buildRunId, LocalState } from "../src/local-state.js";
import type { CommandResult, CommandRunner } from "../src/github.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local state paths", () => {
  it("builds deterministic run ids and branch names", () => {
    expect(buildRunId("fankaidev/grovie", 5)).toBe("fankaidev-grovie-issue-5");
    expect(buildBranchName("grovie/", 5)).toBe("grovie/issue-5");
    expect(buildBranchName("grovie", 5)).toBe("grovie/issue-5");
  });
});

describe("LocalState", () => {
  it("creates repo cache, worktree, and run artifacts without touching the checkout", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    const run = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      task: {
        issue: 5,
      },
      prompt: "Implement issue #5",
    });

    expect(run.runId).toBe("fankaidev-grovie-issue-5");
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
      ["-C", join(root, "repos", "fankaidev-grovie.git"), "branch", "-D", "grovie/issue-5"],
      [
        "-C",
        join(root, "repos", "fankaidev-grovie.git"),
        "worktree",
        "add",
        "-B",
        "grovie/issue-5",
        join(root, "worktrees", "fankaidev-grovie-issue-5"),
        "main",
      ],
    ]);
  });

  it("fetches existing caches and recreates existing worktree paths", () => {
    const root = createTmpDir();
    const cachePath = join(root, "repos", "fankaidev-grovie.git");
    const worktreePath = join(root, "worktrees", "fankaidev-grovie-issue-5");
    mkdirSync(cachePath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      defaultBranch: "main",
      branchPrefix: "grovie/",
      task: {},
      prompt: "",
    });

    expect(existsSync(worktreePath)).toBe(false);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-C", cachePath, "fetch", "origin", "+refs/heads/main:refs/heads/main"],
      ["-C", cachePath, "worktree", "remove", "--force", worktreePath],
      ["-C", cachePath, "worktree", "prune"],
      ["-C", cachePath, "branch", "-D", "grovie/issue-5"],
      ["-C", cachePath, "worktree", "add", "-B", "grovie/issue-5", worktreePath, "main"],
    ]);
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
        task: {
          issue: 5,
        },
        prompt: "Implement issue #5",
      }),
    ).toThrow("fatal: invalid reference: main");

    const runDir = join(root, "runs", "fankaidev-grovie-issue-5");
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
