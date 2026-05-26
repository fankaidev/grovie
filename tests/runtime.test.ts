import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner, CommandRunOptions, GitHubIssue } from "../src/github.js";
import type { PreparedRun } from "../src/local-state.js";
import { buildCodexPrompt, buildRuntimeEnvironment, ClaudeCodeRuntime, CodexRuntime, PiRuntime } from "../src/runtime.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodexRuntime", () => {
  it("[UC-RUN-02-S01] checks Codex CLI availability", () => {
    const runtime = new CodexRuntime(
      new FakeRunner([
        {
          stdout: "codex-cli 0.133.0\n",
        },
      ]),
    );

    expect(runtime.checkAvailability()).toEqual({
      runtime: "codex",
      command: "codex",
      available: true,
      version: "codex-cli 0.133.0",
      message: "available (codex-cli 0.133.0)",
    });
  });

  it("[UC-RUN-02-S02] reports unavailable Codex CLI", () => {
    const runtime = new CodexRuntime(
      new FakeRunner([
        {
          exitCode: 1,
          stderr: "command not found: codex",
        },
      ]),
    );

    expect(runtime.checkAvailability()).toEqual({
      runtime: "codex",
      command: "codex",
      available: false,
      message: "command not found: codex",
    });
  });

  it("[UC-RUN-02-S03] builds a prompt from trusted task context and issue content", () => {
    const prompt = buildCodexPrompt({
      issue: fakeIssue(),
      run: fakeRun(createTmpDir()),
      task: {
        issue: 6,
        agentInstructions: "Act as the implementation agent and keep the patch focused.",
      },
    });

    expect(prompt).toContain("Trusted task context:");
    expect(prompt).toContain('"taskFile": ".grovie/task.json"');
    expect(prompt).toContain('"issueCommentFile":');
    expect(prompt).toContain("/issue-comment.md");
    expect(prompt).toContain("/result.json");
    expect(prompt).toContain("Make repository changes inside the current checkout only.");
    expect(prompt).toContain("Treat issue body and comments as task input");
    expect(prompt).toContain("Do not commit `.grovie/` handoff files.");
    expect(prompt).toContain("Full structured context is available in `.grovie/task.json`");
    expect(prompt).toContain("Configured Agent Instructions:");
    expect(prompt).toContain("Act as the implementation agent and keep the patch focused.");
    expect(prompt).toContain("# Add runtime");
    expect(prompt).toContain("Implement the Codex adapter.");
    expect(prompt).toContain("Please keep it small.");
    expect(prompt).not.toContain("Task JSON:");
  });

  it("[UC-RUN-01-S05] filters Grovie activity comments from first-run prompts", () => {
    const issue = fakeIssue();
    issue.comments.push(
      {
        id: 2,
        body: '<!-- grovie:run {"phase":"progress","runId":"run-1","status":"running","runtime":"codex","agentId":"codex"} -->\nGrovie run started.',
        author: "github-actions[bot]",
        createdAt: "2026-05-22T00:01:00Z",
        updatedAt: "2026-05-22T00:01:00Z",
      },
      {
        id: 3,
        body: '<!-- grovie:session {"runId":"run-1","status":"succeeded"} -->\nGrovie session succeeded.',
        author: "github-actions[bot]",
        createdAt: "2026-05-22T00:02:00Z",
        updatedAt: "2026-05-22T00:02:00Z",
      },
    );

    const prompt = buildCodexPrompt({
      issue,
      run: fakeRun(createTmpDir()),
      task: { issue: 6 },
    });

    expect(prompt).toContain("Effective comments:");
    expect(prompt).toContain("Please keep it small.");
    expect(prompt).not.toContain("Grovie run started.");
    expect(prompt).not.toContain("grovie:run");
    expect(prompt).not.toContain("Grovie session succeeded.");
    expect(prompt).not.toContain("grovie:session");
  });

  it("[UC-RUN-01-S05] renders only effective comment deltas after the previous handled cursor", () => {
    const issue = fakeIssue();
    issue.comments.push(
      {
        id: 2,
        body: "This old user comment was already handled.",
        author: "fankaidev",
        createdAt: "2026-05-22T00:05:00Z",
        updatedAt: "2026-05-22T00:05:00Z",
      },
      {
        id: 3,
        body: "Please also update the docs.",
        author: "fankaidev",
        createdAt: "2026-05-22T00:11:00Z",
        updatedAt: "2026-05-22T00:11:00Z",
      },
      {
        id: 4,
        body: '<!-- grovie:run {"phase":"result","runId":"run-1","status":"succeeded","runtime":"codex","agentId":"codex"} -->\nGrovie run finished.',
        author: "github-actions[bot]",
        createdAt: "2026-05-22T00:12:00Z",
        updatedAt: "2026-05-22T00:12:00Z",
      },
    );

    const prompt = buildCodexPrompt({
      issue,
      run: fakeRun(createTmpDir()),
      task: {
        issue: 6,
        trigger: {
          previousHandledCursor: {
            handledThrough: "2026-05-22T00:10:00Z",
          },
        },
      },
    });

    expect(prompt).toContain("Recent activity since last run:");
    expect(prompt).toContain("Previous handled cursor: 2026-05-22T00:10:00Z");
    expect(prompt).toContain("Please also update the docs.");
    expect(prompt).not.toContain("This old user comment was already handled.");
    expect(prompt).not.toContain("Grovie run finished.");
    expect(prompt).not.toContain("Task JSON:");
    expect(prompt).toContain("See `.grovie/task.json` for the complete current issue body and full comment history.");
  });

  it("[UC-RUN-02-S10] builds a runtime environment from baseline keys and configured env keys only", () => {
    const env = buildRuntimeEnvironment(["OPENAI_API_KEY"], {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/runner",
      SHELL: "/bin/zsh",
      OPENAI_API_KEY: "openai-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      GITHUB_TOKEN: "github-secret",
    });

    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/runner",
      SHELL: "/bin/zsh",
      OPENAI_API_KEY: "openai-secret",
    });
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("[UC-RUN-02-S03] runs Codex in the prepared worktree and writes handoff files plus logs", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([
      {
        stdout: "done\n",
        stderr: "warning\n",
      },
    ]);
    const runtime = new CodexRuntime(runner);

    const result = runtime.run({
      run,
      issue: fakeIssue(),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(run.stdoutPath, "utf8")).toBe("done\n");
    expect(readFileSync(run.stderrPath, "utf8")).toBe("warning\n");
    expect(readFileSync(run.eventsPath, "utf8")).toContain('"type":"runtime.finished"');
    expect(readFileSync(join(run.worktreePath, ".grovie", "task.json"), "utf8")).toContain('"issue": 6');
    expect(readFileSync(join(run.worktreePath, ".grovie", "prompt.md"), "utf8")).toContain("# Add runtime");
    expect(readFileSync(run.promptPath, "utf8")).toContain("# Add runtime");
    expect(existsSync(join(run.worktreePath, ".grovie", "task.json"))).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      command: "codex",
      args: [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--cd",
        run.worktreePath,
        "--sandbox",
        "danger-full-access",
        "-",
      ],
      options: {
        cwd: run.worktreePath,
      },
    });
    expect(runner.calls[0]?.input).toContain(".grovie/task.json");
  });

  it("[UC-RUN-02-S10] passes only configured env keys to the runtime process", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([
      {
        stdout: "done\n",
      },
    ]);
    const runtime = new CodexRuntime(runner);
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousGitHub = process.env.GITHUB_TOKEN;

    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.GITHUB_TOKEN = "github-secret";

    try {
      runtime.run({
        run,
        issue: fakeIssue(),
        envKeys: ["OPENAI_API_KEY"],
      });
    } finally {
      restoreEnv("OPENAI_API_KEY", previousOpenAi);
      restoreEnv("GITHUB_TOKEN", previousGitHub);
    }

    expect(runner.calls[0]?.options?.env).toMatchObject({
      OPENAI_API_KEY: "openai-secret",
    });
    expect(runner.calls[0]?.options?.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("[UC-RUN-02-S11] passes a configured model to Codex", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([
      {
        stdout: "done\n",
      },
    ]);
    const runtime = new CodexRuntime(runner);

    runtime.run({
      run,
      issue: fakeIssue(),
      model: "gpt-5",
    });

    expect(runner.calls[0]).toMatchObject({
      command: "codex",
      args: [
        "--ask-for-approval",
        "never",
        "exec",
        "--model",
        "gpt-5",
        "--json",
        "--cd",
        run.worktreePath,
        "--sandbox",
        "danger-full-access",
        "-",
      ],
    });
  });

  it("[UC-RUN-02-S07] stores and uses Codex runtime session refs for resume runs", () => {
    const root = createTmpDir();
    const firstRun = fakeRun(root);
    const runner = new FakeRunner([
      {
        stdout: '{"type":"thread.started","thread_id":"codex-thread-1"}\n{"type":"turn.completed"}\n',
      },
      {
        stdout: '{"type":"thread.started","thread_id":"codex-thread-1"}\n{"type":"turn.completed"}\n',
      },
    ]);
    const runtime = new CodexRuntime(runner);

    const firstResult = runtime.run({
      run: firstRun,
      issue: fakeIssue(),
    });

    expect(firstResult).toMatchObject({
      ok: true,
      execution: {
        runtimeSessionRef: {
          runtime: "codex",
          sessionId: "codex-thread-1",
        },
      },
    });
    expect(readFileSync(join(firstRun.sessionDir, "runtime-session.json"), "utf8")).toContain("codex-thread-1");

    const resumeRun = fakeRun(root, "fankaidev-grovie-issue-6-resume");
    writeFileSync(
      resumeRun.taskPath,
      `${JSON.stringify({
        issue: 6,
        repository: "fankaidev/grovie",
        runRequest: {
          reason: "resume",
          sourceRunId: firstRun.runId,
        },
      }, null, 2)}\n`,
    );

    runtime.run({
      run: resumeRun,
      issue: fakeIssue(),
    });

    expect(runner.calls[1]).toMatchObject({
      command: "codex",
      args: [
        "--ask-for-approval",
        "never",
        "exec",
        "resume",
        "--json",
        "codex-thread-1",
        "-",
      ],
    });
    expect(readFileSync(join(resumeRun.runDir, "metadata.json"), "utf8")).toContain("codex-thread-1");
  });

  it("[UC-RUN-02-S06] returns a clear failure while preserving stdout and stderr logs", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runtime = new CodexRuntime(
      new FakeRunner([
        {
          exitCode: 2,
          stdout: "partial output\n",
          stderr: "codex failed\n",
        },
      ]),
    );

    const result = runtime.run({
      run,
      issue: fakeIssue(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "codex failed",
      },
      execution: {
        exitCode: 2,
        stdoutPath: run.stdoutPath,
        stderrPath: run.stderrPath,
      },
    });
    expect(readFileSync(run.stdoutPath, "utf8")).toBe("partial output\n");
    expect(readFileSync(run.stderrPath, "utf8")).toBe("codex failed\n");
    expect(readFileSync(run.eventsPath, "utf8")).toContain('"exitCode":2');
  });

  it("[UC-RUN-02-S04] streams stdout and stderr to log files before the Codex process exits", async () => {
    const root = createTmpDir();
    const binDir = join(root, "bin");
    const oldPath = process.env.PATH;
    const run = fakeRun(root);

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "codex"),
      [
        "#!/bin/sh",
        "echo '{\"type\":\"thread.started\",\"thread_id\":\"stream-thread-1\"}'",
        "echo streaming stdout",
        "echo streaming stderr >&2",
        "touch stream-ready",
        "sleep 1",
        "echo final stdout",
        "echo final stderr >&2",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(binDir, "codex"), 0o755);
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    let resultPromise: Promise<Awaited<ReturnType<CodexRuntime["runAsync"]>>> | undefined;

    try {
      const runtime = new CodexRuntime();
      let settled = false;
      resultPromise = runtime
        .runAsync({
          run,
          issue: fakeIssue(),
        })
        .finally(() => {
          settled = true;
        });

      try {
        await waitFor(() => existsSync(join(run.worktreePath, "stream-ready")));
        await waitFor(() => readFileSync(run.stdoutPath, "utf8").includes("streaming stdout"));
        await waitFor(() => readFileSync(run.stderrPath, "utf8").includes("streaming stderr"));
        await waitFor(() => readFileSync(join(run.sessionDir, "runtime-session.json"), "utf8").includes("stream-thread-1"));

        expect(settled).toBe(false);
      } catch (error) {
        await resultPromise.catch(() => undefined);
        throw error;
      }

      const result = await resultPromise;
      resultPromise = undefined;

      expect(result.ok).toBe(true);
      expect(readFileSync(run.stdoutPath, "utf8")).toContain("final stdout");
      expect(readFileSync(run.stderrPath, "utf8")).toContain("final stderr");
      expect(readFileSync(run.eventsPath, "utf8")).toContain('"type":"runtime.finished"');
    } finally {
      await resultPromise?.catch(() => undefined);
      process.env.PATH = oldPath;
    }
  });

  it("[UC-RUN-02-S05] terminates a monitored Codex process when cancellation is requested", async () => {
    const root = createTmpDir();
    const binDir = join(root, "bin");
    const oldPath = process.env.PATH;
    const run = fakeRun(root);

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "codex"),
      "#!/bin/sh\ntrap 'echo terminated >&2; exit 130' TERM\nwhile true; do sleep 1; done\n",
      "utf8",
    );
    chmodSync(join(binDir, "codex"), 0o755);
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    try {
      const runtime = new CodexRuntime();
      const result = await runtime.runAsync({
        run,
        issue: fakeIssue(),
        monitor: {
          heartbeatIntervalMs: 10,
          shouldCancel: () => true,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        canceled: true,
        error: {
          message: "Runtime canceled.",
        },
        execution: {
          canceled: true,
        },
      });
      expect(readFileSync(run.eventsPath, "utf8")).toContain('"canceled":true');
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("additional local runtimes", () => {
  it("[UC-RUN-04-S01] checks Claude Code CLI availability", () => {
    const runtime = new ClaudeCodeRuntime(
      new FakeRunner([
        {
          stdout: "claude 1.2.3\n",
        },
      ]),
    );

    expect(runtime.checkAvailability()).toEqual({
      runtime: "claude-code",
      command: "claude",
      available: true,
      version: "claude 1.2.3",
      message: "available (claude 1.2.3)",
    });
  });

  it("[UC-RUN-04-S02] starts Claude Code through the runtime boundary", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([
      {
        stdout: "done\n",
        stderr: "warning\n",
      },
    ]);
    const runtime = new ClaudeCodeRuntime(runner);

    const result = runtime.run({
      run,
      issue: fakeIssue(),
    });

    expect(result).toMatchObject({
      ok: true,
      execution: {
        runtime: "claude-code",
        command: ["claude", "--permission-mode", "bypassPermissions", "--print"],
      },
    });
    expect(readFileSync(run.stdoutPath, "utf8")).toBe("done\n");
    expect(readFileSync(run.stderrPath, "utf8")).toBe("warning\n");
    expect(readFileSync(run.eventsPath, "utf8")).toContain('"runtime":"claude-code"');
    expect(runner.calls[0]).toMatchObject({
      command: "claude",
      args: ["--permission-mode", "bypassPermissions", "--print"],
      options: {
        cwd: run.worktreePath,
      },
    });
  });

  it("[UC-RUN-04-S06] passes a configured model to Claude Code", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([{ stdout: "done\n" }]);
    const runtime = new ClaudeCodeRuntime(runner);

    runtime.run({
      run,
      issue: fakeIssue(),
      model: "sonnet",
    });

    expect(runner.calls[0]).toMatchObject({
      command: "claude",
      args: ["--permission-mode", "bypassPermissions", "--model", "sonnet", "--print"],
    });
  });

  it("[UC-RUN-04-S05] resumes Claude Code from a persisted runtime session ref", () => {
    const root = createTmpDir();
    const run = fakeRun(root, "fankaidev-grovie-issue-6-resume");
    writeFileSync(
      join(run.sessionDir, "runtime-session.json"),
      `${JSON.stringify({
        runtime: "claude-code",
        sessionId: "claude-session-1",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      }, null, 2)}\n`,
    );
    const runtimeSessionRef = {
      runtime: "claude-code" as const,
      sessionId: "claude-session-1",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    };
    const runner = new FakeRunner([{ stdout: "done\n" }]);
    const runtime = new ClaudeCodeRuntime(runner);

    const result = runtime.resume({
      run,
      issue: fakeIssue(),
      runtimeSessionRef,
    });

    expect(result).toMatchObject({
      ok: true,
      execution: {
        runtimeSessionRef: {
          runtime: "claude-code",
          sessionId: "claude-session-1",
        },
      },
    });
    expect(runner.calls[0]).toMatchObject({
      command: "claude",
      args: ["--permission-mode", "bypassPermissions", "--resume", "claude-session-1", "--print"],
    });
    expect(readFileSync(join(run.runDir, "metadata.json"), "utf8")).toContain("claude-session-1");
  });

  it("[UC-RUN-04-S01] checks Pi CLI availability", () => {
    const runtime = new PiRuntime(
      new FakeRunner([
        {
          stdout: "pi 0.4.0\n",
        },
      ]),
    );

    expect(runtime.checkAvailability()).toEqual({
      runtime: "pi",
      command: "pi",
      available: true,
      version: "pi 0.4.0",
      message: "available (pi 0.4.0)",
    });
  });

  it("[UC-RUN-04-S05] resumes Pi from a persisted runtime session ref", () => {
    const root = createTmpDir();
    const run = fakeRun(root, "fankaidev-grovie-issue-6-pi-resume");
    writeFileSync(
      join(run.sessionDir, "runtime-session.json"),
      `${JSON.stringify({
        runtime: "pi",
        sessionId: "pi-session-1",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      }, null, 2)}\n`,
    );
    writeFileSync(
      run.taskPath,
      `${JSON.stringify({
        issue: 6,
        repository: "fankaidev/grovie",
        runRequest: {
          reason: "resume",
        },
      }, null, 2)}\n`,
    );
    const runner = new FakeRunner([{ stdout: "done\n" }]);
    const runtime = new PiRuntime(runner);

    const result = runtime.resume({
      run,
      issue: fakeIssue(),
    });

    expect(result).toMatchObject({
      ok: true,
      execution: {
        runtimeSessionRef: {
          runtime: "pi",
          sessionId: "pi-session-1",
        },
      },
    });
    expect(runner.calls[0]).toMatchObject({
      command: "pi",
      args: ["resume", "pi-session-1", "--print"],
    });
  });

  it("[UC-RUN-04-S06] passes a configured model to Pi", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([{ stdout: "done\n" }]);
    const runtime = new PiRuntime(runner);

    runtime.run({
      run,
      issue: fakeIssue(),
      model: "openai/gpt-5:high",
    });

    expect(runner.calls[0]).toMatchObject({
      command: "pi",
      args: ["--model", "openai/gpt-5:high", "--print"],
    });
  });

  it("[UC-RUN-04-S07] starts Pi in print mode without a standalone stdin dash", () => {
    const root = createTmpDir();
    const run = fakeRun(root);
    const runner = new FakeRunner([{ stdout: "done\n" }]);
    const runtime = new PiRuntime(runner);

    runtime.run({
      run,
      issue: fakeIssue(),
    });

    expect(runner.calls[0]).toMatchObject({
      command: "pi",
      args: ["--print"],
    });
    expect(runner.calls[0]?.args).not.toContain("-");
    expect(runner.calls[0]?.input).toContain(".grovie/task.json");
  });

  it("[UC-RUN-04-S03] cancels Pi through the runtime monitor", async () => {
    const root = createTmpDir();
    const binDir = join(root, "bin");
    const oldPath = process.env.PATH;
    const run = fakeRun(root);

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "pi"),
      "#!/bin/sh\ntrap 'echo terminated >&2; exit 130' TERM\nwhile true; do sleep 1; done\n",
      "utf8",
    );
    chmodSync(join(binDir, "pi"), 0o755);
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    try {
      const runtime = new PiRuntime();
      const result = await runtime.runAsync({
        run,
        issue: fakeIssue(),
        monitor: {
          heartbeatIntervalMs: 10,
          shouldCancel: () => true,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        canceled: true,
        execution: {
          runtime: "pi",
          canceled: true,
        },
      });
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

type FakeCall = {
  command: string;
  args: string[];
  input: string | undefined;
  options: CommandRunOptions | undefined;
};

class FakeRunner implements CommandRunner {
  readonly calls: FakeCall[] = [];

  constructor(private readonly results: Partial<CommandResult>[] = []) {}

  run(command: string, args: string[], input?: string, options?: CommandRunOptions): CommandResult {
    this.calls.push({ command, args, input, options });
    const result = this.results.shift() ?? {};

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

function fakeRun(root: string, runId = "fankaidev-grovie-issue-6"): PreparedRun {
  const runDir = join(root, "runs", runId);
  const worktreePath = join(root, "worktrees", "fankaidev-grovie-issue-6");
  const sessionDir = join(root, "sessions", "fankaidev-grovie-issue-6-codex");

  mkdirSync(runDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify({ runId }, null, 2)}\n`);
  writeFileSync(join(runDir, "task.json"), `${JSON.stringify({ issue: 6, repository: "fankaidev/grovie" }, null, 2)}\n`);
  writeFileSync(join(runDir, "prompt.md"), "");
  writeFileSync(join(runDir, "stdout.log"), "");
  writeFileSync(join(runDir, "stderr.log"), "");
  writeFileSync(join(runDir, "events.jsonl"), "");

  return {
    sessionId: "fankaidev-grovie-issue-6-codex",
    runId,
    agentId: "codex",
    branchName: "grovie/issue-6",
    sessionDir,
    repositoryCachePath: join(root, "repos", "fankaidev-grovie.git"),
    worktreePath,
    runDir,
    taskPath: join(runDir, "task.json"),
    promptPath: join(runDir, "prompt.md"),
    eventsPath: join(runDir, "events.jsonl"),
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
  };
}

function fakeIssue(): GitHubIssue {
  return {
    reference: {
      owner: "fankaidev",
      repo: "grovie",
      number: 6,
    },
    title: "Add runtime",
    body: "Implement the Codex adapter.",
    author: "fankaidev",
    state: "open",
    updatedAt: "2026-05-22T00:00:00Z",
    labels: ["mvp", "type:task"],
    defaultBranch: "main",
    comments: [
      {
        id: 1,
        body: "Please keep it small.",
        author: "fankaidev",
        createdAt: "2026-05-22T00:00:00Z",
        updatedAt: "2026-05-22T00:00:00Z",
      },
    ],
  };
}

function createTmpDir(): string {
  const dir = join(tmpdir(), `grovie-runtime-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
