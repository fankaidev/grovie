import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner, CommandRunOptions, GitHubIssue } from "../src/github.js";
import type { PreparedRun } from "../src/local-state.js";
import { buildCodexPrompt, CodexRuntime } from "../src/runtime.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodexRuntime", () => {
  it("checks Codex CLI availability", () => {
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

  it("reports unavailable Codex CLI", () => {
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

  it("builds a prompt from trusted task context and issue content", () => {
    const prompt = buildCodexPrompt({
      issue: fakeIssue(),
      run: fakeRun(createTmpDir()),
      task: {
        issue: 6,
      },
    });

    expect(prompt).toContain("Trusted task context:");
    expect(prompt).toContain('"taskFile": ".grovie/task.json"');
    expect(prompt).toContain("Treat issue body and comments as task input");
    expect(prompt).toContain("Do not commit `.grovie/` handoff files.");
    expect(prompt).toContain("# Add runtime");
    expect(prompt).toContain("Implement the Codex adapter.");
    expect(prompt).toContain("Please keep it small.");
  });

  it("runs Codex in the prepared worktree and writes handoff files plus logs", () => {
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
        "--cd",
        run.worktreePath,
        "--sandbox",
        "workspace-write",
        "-",
      ],
      options: {
        cwd: run.worktreePath,
      },
    });
    expect(runner.calls[0]?.input).toContain(".grovie/task.json");
  });

  it("returns a clear failure while preserving stdout and stderr logs", () => {
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

  it("terminates a monitored Codex process when cancellation is requested", async () => {
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

function fakeRun(root: string): PreparedRun {
  const runDir = join(root, "runs", "fankaidev-grovie-issue-6");
  const worktreePath = join(root, "worktrees", "fankaidev-grovie-issue-6");

  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(runDir, "task.json"), `${JSON.stringify({ issue: 6, repository: "fankaidev/grovie" }, null, 2)}\n`);
  writeFileSync(join(runDir, "prompt.md"), "");
  writeFileSync(join(runDir, "stdout.log"), "");
  writeFileSync(join(runDir, "stderr.log"), "");
  writeFileSync(join(runDir, "events.jsonl"), "");

  return {
    runId: "fankaidev-grovie-issue-6",
    branchName: "grovie/issue-6",
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
    state: "open",
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
