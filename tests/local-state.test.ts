import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBranchName, buildLocalBranchName, buildRunId, buildRunTimestamp, buildSessionId, LocalState } from "../src/local-state.js";
import type { CommandResult, CommandRunner } from "../src/github.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local state paths", () => {
  it("[UC-EXECUTION-02-S01] [UC-EXECUTION-02-S02] builds session ids and timestamped run ids", () => {
    const sessionId = buildSessionId("fankaidev/grovie", 123, "coder@fankai-mac");

    expect(sessionId).toBe("fankaidev-grovie-issue-123-coder-fankai-mac");
    expect(buildRunTimestamp(new Date("2026-05-23T00:00:01Z"))).toBe("20260523T000001Z");
    expect(buildRunTimestamp(new Date("2026-05-23T00:00:01.456Z"))).toBe("20260523T000001Z");
    expect(buildRunId(sessionId, "20260523T000001Z")).toBe(
      "fankaidev-grovie-issue-123-coder-fankai-mac-20260523T000001Z",
    );
    expect(buildBranchName("grovie/", sessionId)).toBe("grovie/fankaidev-grovie-issue-123-coder-fankai-mac");
    expect(buildLocalBranchName("grovie", sessionId)).toBe("grovie/fankaidev-grovie-issue-123-coder-fankai-mac");
  });
});

describe("LocalState", () => {
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

  it("[UC-EXECUTION-02-S09] preserves retry source metadata in daemon run requests", () => {
    const root = createTmpDir();
    const state = new LocalState({ paths: { root }, runner: new FakeRunner() });

    const request = state.enqueueRunRequest({
      repository: "fankaidev/grovie",
      issueNumber: 79,
      agentId: "coder@fankai-mac",
      sourceRunId: "failed-run",
      reason: "retry",
      now: new Date("2026-05-23T00:00:00Z"),
    });

    expect(JSON.parse(readFileSync(request.path, "utf8"))).toMatchObject({
      repository: "fankaidev/grovie",
      issueNumber: 79,
      agentId: "coder@fankai-mac",
      sourceRunId: "failed-run",
      reason: "retry",
    });
    expect(state.takeRunRequest("fankaidev/grovie")).toMatchObject({
      sourceRunId: "failed-run",
      reason: "retry",
    });
  });

  it("[UC-EXECUTION-02-S09] writes retry trace metadata into prepared run history", () => {
    const root = createTmpDir();
    const state = new LocalState({ paths: { root }, runner: new FakeRunner() });

    const run = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 79,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:00Z"),
      prompt: "Prompt",
      task: {},
      runRequest: {
        sourceRunId: "failed-run",
        reason: "retry",
      },
    });

    expect(JSON.parse(readFileSync(join(run.runDir, "metadata.json"), "utf8"))).toMatchObject({
      runRequest: {
        sourceRunId: "failed-run",
        reason: "retry",
      },
    });
  });

  it("[UC-ADMIN-05-S01] records local run cancellation requests on disk", () => {
    const root = createTmpDir();
    const state = new LocalState({ paths: { root }, runner: new FakeRunner() });
    const run = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 75,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:00Z"),
      prompt: "Prompt",
      task: {},
    });

    const cancellation = state.requestRunCancellation({
      runId: run.runId,
      reason: "Canceled from test.",
      now: new Date("2026-05-23T00:01:00Z"),
    });

    expect(cancellation).toMatchObject({
      runId: run.runId,
      reason: "Canceled from test.",
    });
    expect(state.isRunCancellationRequested(run.runId)).toBe(true);
    expect(readFileSync(run.eventsPath, "utf8")).toContain("run.cancel_requested");
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

  it("[UC-EXECUTION-02-S05] keeps handled cursors separate per agent", () => {
    const state = new LocalState({ paths: { root: createTmpDir() }, runner: new FakeRunner() });

    state.writeHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "coder@fankai-mac",
      handledThrough: "2026-05-23T00:00:00.000Z",
      issueFingerprint: "issue-fingerprint-1",
      now: new Date("2026-05-23T00:00:01.000Z"),
    });

    expect(state.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "coder@fankai-mac",
    })).toEqual({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "coder@fankai-mac",
      handledThrough: "2026-05-23T00:00:00.000Z",
      issueFingerprint: "issue-fingerprint-1",
      updatedAt: "2026-05-23T00:00:01.000Z",
    });
    expect(state.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "reviewer@fankai-mac",
    })).toBeUndefined();
  });

  it("[UC-EXECUTION-04-S01] [UC-EXECUTION-04-S05] creates session worktree and run artifacts without touching the checkout", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });
    const sessionId = "fankaidev-grovie-issue-5-coder-fankai-mac";
    const runId = `${sessionId}-20260523T000001Z`;

    const run = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:01Z"),
      task: {
        issue: 5,
      },
      prompt: "Implement issue #5",
    });

    expect(run.sessionId).toBe(sessionId);
    expect(run.runId).toBe(runId);
    expect(run.branchName).toBe(`grovie/${sessionId}`);
    expect(run.sessionDir).toBe(join(root, "sessions", sessionId));
    expect(run.worktreePath).toBe(join(root, "worktrees", sessionId));
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
      [
        "-C",
        join(root, "repos", "fankaidev-grovie.git"),
        "worktree",
        "add",
        "-B",
        `grovie/${sessionId}`,
        join(root, "worktrees", sessionId),
        "main",
      ],
    ]);
  });

  it("[UC-EXECUTION-04-S02] reuses the existing session worktree and branch", () => {
    const root = createTmpDir();
    const cachePath = join(root, "repos", "fankaidev-grovie.git");
    const sessionId = "fankaidev-grovie-issue-5-coder-fankai-mac";
    const worktreePath = join(root, "worktrees", sessionId);
    mkdirSync(cachePath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:01Z"),
      task: {},
      prompt: "",
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-C", cachePath, "fetch", "origin", "+refs/heads/main:refs/heads/main"],
    ]);
  });

  it("[UC-EXECUTION-04-S03] creates separate sessions for different agents on one issue", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    const first = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:01Z"),
      task: {},
      prompt: "",
    });
    const second = state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "reviewer@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:02Z"),
      task: {},
      prompt: "",
    });

    expect(first.sessionId).toBe("fankaidev-grovie-issue-5-coder-fankai-mac");
    expect(second.sessionId).toBe("fankaidev-grovie-issue-5-reviewer-fankai-mac");
    expect(first.branchName).toBe("grovie/fankaidev-grovie-issue-5-coder-fankai-mac");
    expect(second.branchName).toBe("grovie/fankaidev-grovie-issue-5-reviewer-fankai-mac");
    expect(first.runId).not.toBe(second.runId);
    expect(first.worktreePath).not.toBe(second.worktreePath);
  });

  it("[UC-EXECUTION-04-S04] reuses session state after constructing a new LocalState", () => {
    const root = createTmpDir();
    const firstRunner = new FakeRunner();
    const firstState = new LocalState({ paths: { root }, runner: firstRunner });
    const first = firstState.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:01Z"),
      task: {},
      prompt: "",
    });
    mkdirSync(first.worktreePath, { recursive: true });
    const secondRunner = new FakeRunner();
    const secondState = new LocalState({ paths: { root }, runner: secondRunner });

    const second = secondState.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:02Z"),
      task: {},
      prompt: "",
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.branchName).toBe(first.branchName);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.runId).toBe("fankaidev-grovie-issue-5-coder-fankai-mac-20260523T000002Z");
    expect(readFileSync(join(root, "sessions", first.sessionId, "session.json"), "utf8")).toContain(first.sessionId);
    expect(secondRunner.calls.map((call) => call.args)).toEqual([
      [
        "clone",
        "--bare",
        "https://github.com/fankaidev/grovie.git",
        join(root, "repos", "fankaidev-grovie.git"),
      ],
      [
        "-C",
        join(root, "repos", "fankaidev-grovie.git"),
        "fetch",
        "origin",
        "+refs/heads/main:refs/heads/main",
      ],
    ]);
  });

  it("[UC-EXECUTION-02-S06] fails clearly when a timestamped run id collides", () => {
    const root = createTmpDir();
    const runner = new FakeRunner();
    const state = new LocalState({ paths: { root }, runner });

    state.prepareRun({
      repository: "fankaidev/grovie",
      issueNumber: 5,
      agentId: "coder@fankai-mac",
      defaultBranch: "main",
      branchPrefix: "grovie/",
      now: new Date("2026-05-23T00:00:01Z"),
      task: {},
      prompt: "",
    });

    expect(() =>
      state.prepareRun({
        repository: "fankaidev/grovie",
        issueNumber: 5,
        agentId: "coder@fankai-mac",
        defaultBranch: "main",
        branchPrefix: "grovie/",
        now: new Date("2026-05-23T00:00:01Z"),
        task: {},
        prompt: "",
      }),
    ).toThrow(
      "Run id fankaidev-grovie-issue-5-coder-fankai-mac-20260523T000001Z already exists. Retry after the current UTC second",
    );
  });

  it("[UC-EXECUTION-04-S06] preserves run artifacts when worktree preparation fails", () => {
    const root = createTmpDir();
    const runner = new FakeRunner({ failWorktreeAdd: true });
    const state = new LocalState({ paths: { root }, runner });

    expect(() =>
      state.prepareRun({
        repository: "fankaidev/grovie",
        issueNumber: 5,
        agentId: "coder@fankai-mac",
        defaultBranch: "main",
        branchPrefix: "grovie/",
        now: new Date("2026-05-23T00:00:01Z"),
        task: {
          issue: 5,
        },
        prompt: "Implement issue #5",
      }),
    ).toThrow("fatal: invalid reference: main");

    const runDir = join(root, "runs", "fankaidev-grovie-issue-5-coder-fankai-mac-20260523T000001Z");
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

  constructor(private readonly options: { failWorktreeAdd?: boolean; repositoryFiles?: Record<string, string> } = {}) {}

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

    if (args.includes("ls-remote")) {
      return {
        exitCode: 0,
        stdout: "ref: refs/heads/main\tHEAD\n",
        stderr: "",
      };
    }

    if (args.includes("show")) {
      const spec = args.at(-1) ?? "";
      const filePath = spec.split(":").at(1) ?? "";
      const content = this.options.repositoryFiles?.[filePath];

      if (content === undefined) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: path '${filePath}' does not exist in 'main'`,
        };
      }

      return {
        exitCode: 0,
        stdout: content,
        stderr: "",
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
