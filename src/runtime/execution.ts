import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../github.js";
import type { PreparedRun } from "../local-state.js";
import { buildRuntimeEnvironment } from "./environment.js";
import { buildCodexPrompt } from "./prompt.js";
import type { AgentRunInput, PreparedRuntimeInput, RuntimeAdapter, RuntimeCommandResult, RuntimeExecution, RuntimeName, RuntimeRunOptions, RuntimeRunResult, RuntimeSessionRef } from "./types.js";

export function runRuntimeSync(
  input: AgentRunInput,
  adapter: RuntimeAdapter,
  runner: CommandRunner,
  options: RuntimeRunOptions = {},
): RuntimeRunResult {
  const preparedInput = prepareRuntimeInput(input, adapter, options);
  const result = runner.run(preparedInput.command[0] ?? adapter.command, preparedInput.command.slice(1), preparedInput.prompt, {
    cwd: input.run.worktreePath,
    env: preparedInput.env,
    maxBuffer: 1024 * 1024 * 50,
  });

  return finishCliRun(input, preparedInput, {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export async function runRuntimeAsync(
  input: AgentRunInput,
  adapter: RuntimeAdapter,
  options: RuntimeRunOptions = {},
): Promise<RuntimeRunResult> {
  const preparedInput = prepareRuntimeInput(input, adapter, options);
  const result = await runStreamingCommand(input, preparedInput);

  return finishCliRun(input, preparedInput, result);
}

function prepareRuntimeInput(input: AgentRunInput, adapter: RuntimeAdapter, options: RuntimeRunOptions = {}): PreparedRuntimeInput {
  const task = JSON.parse(readFileSync(input.run.taskPath, "utf8")) as unknown;
  const prompt = buildCodexPrompt({
    issue: input.issue,
    run: input.run,
    task,
  });
  const handoffDir = join(input.run.worktreePath, ".grovie");
  const worktreeTaskPath = join(handoffDir, "task.json");
  const worktreePromptPath = join(handoffDir, "prompt.md");
  const shouldResume = options.mode === "resume" || (options.mode !== "start" && shouldResumeRuntimeSession(task));
  const existingSessionRef = shouldResume
    ? options.runtimeSessionRef ?? readRuntimeSessionRef(input.run.sessionDir, adapter.runtime)
    : undefined;
  const command = existingSessionRef === undefined
    ? adapter.startCommand(input)
    : adapter.resumeCommand(existingSessionRef.sessionId, input);
  const env = buildRuntimeEnvironment(input.envKeys);
  const startedAt = new Date().toISOString();

  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(input.run.promptPath, prompt, "utf8");
  writeFileSync(worktreePromptPath, prompt, "utf8");
  writeFileSync(worktreeTaskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  appendRuntimeEvent(input.run, "runtime.started", {
    runtime: adapter.runtime,
    command,
    runtimeSessionRef: existingSessionRef,
    promptPath: input.run.promptPath,
    taskPath: input.run.taskPath,
    worktreePromptPath,
    worktreeTaskPath,
    startedAt,
  });

  return {
    runtime: adapter.runtime,
    prompt,
    command,
    env,
    worktreeTaskPath,
    worktreePromptPath,
    runtimeSessionRef: existingSessionRef,
    startedAt,
  };
}

function finishCliRun(
  input: AgentRunInput,
  preparedInput: PreparedRuntimeInput,
  result: RuntimeCommandResult,
): RuntimeRunResult {
  const endedAt = new Date().toISOString();

    const execution: RuntimeExecution = {
      runtime: preparedInput.runtime,
      command: preparedInput.command,
      startedAt: preparedInput.startedAt,
      endedAt,
      exitCode: result.exitCode,
      promptPath: input.run.promptPath,
      taskPath: input.run.taskPath,
      worktreePromptPath: preparedInput.worktreePromptPath,
      worktreeTaskPath: preparedInput.worktreeTaskPath,
      stdoutPath: input.run.stdoutPath,
      stderrPath: input.run.stderrPath,
      signal: result.signal,
      canceled: result.canceled,
    };
    const runtimeSessionRef = parseRuntimeSessionRef(preparedInput.runtime, result.stdout, result.stderr, input.run.sessionDir)
      ?? preparedInput.runtimeSessionRef;

    if (runtimeSessionRef !== undefined) {
      execution.runtimeSessionRef = runtimeSessionRef;
      writeRunRuntimeSessionRef(input.run.runDir, runtimeSessionRef);
    }

    if (result.streamed !== true && result.stdout.length > 0) {
      writeFileSync(input.run.stdoutPath, result.stdout, "utf8");
    }

    if (result.streamed !== true && result.stderr.length > 0) {
      writeFileSync(input.run.stderrPath, result.stderr, "utf8");
    }

    appendRuntimeEvent(input.run, "runtime.finished", {
      runtime: preparedInput.runtime,
      exitCode: result.exitCode,
      runtimeSessionRef,
      signal: result.signal,
      canceled: result.canceled,
      startedAt: preparedInput.startedAt,
      endedAt,
      stdoutPath: input.run.stdoutPath,
      stderrPath: input.run.stderrPath,
    });

    if (result.exitCode === 0 && result.canceled !== true) {
      return {
        ok: true,
        execution,
      };
    }

    return {
      ok: false,
      execution,
      canceled: result.canceled,
      error: {
        message:
          result.canceled === true
            ? "Runtime canceled."
            : result.stderr.trim() || result.stdout.trim() || `${preparedInput.runtime} failed with exit code ${result.exitCode}.`,
      },
    };
}

function shouldResumeRuntimeSession(task: unknown): boolean {
  if (task === null || typeof task !== "object") {
    return false;
  }

  const runRequest = (task as { runRequest?: unknown }).runRequest;

  return runRequest !== null
    && typeof runRequest === "object"
    && (runRequest as { reason?: unknown }).reason === "resume";
}

function readRuntimeSessionRef(sessionDir: string, runtime: RuntimeName): RuntimeSessionRef | undefined {
  const path = join(sessionDir, "runtime-session.json");

  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeSessionRef>;

    if (parsed.runtime !== runtime || typeof parsed.sessionId !== "string") {
      return undefined;
    }

    return {
      runtime,
      sessionId: parsed.sessionId,
      createdAt: parsed.createdAt ?? "",
      updatedAt: parsed.updatedAt ?? "",
    };
  } catch {
    return undefined;
  }
}

function parseRuntimeSessionRef(
  runtime: RuntimeName,
  stdout: string,
  stderr: string,
  sessionDir: string,
): RuntimeSessionRef | undefined {
  const sessionId = [...stdout.split("\n"), ...stderr.split("\n")]
    .flatMap((line) => parseRuntimeSessionId(runtime, line))[0];

  if (sessionId === undefined) {
    return undefined;
  }

  const existing = readRuntimeSessionRef(sessionDir, runtime);
  const now = new Date().toISOString();
  const ref = {
    runtime,
    sessionId,
    createdAt: existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : now,
    updatedAt: now,
  };

  writeRuntimeSessionRef(sessionDir, ref);
  return ref;
}

function captureStreamingRuntimeSessionRef(
  runtime: RuntimeName,
  lineBuffer: string,
  chunk: string,
  run: PreparedRun,
): string {
  const text = `${lineBuffer}${chunk}`;
  const lines = text.split("\n");
  const remainder = lines.pop() ?? "";

  if (readRuntimeSessionRef(run.sessionDir, runtime) !== undefined) {
    return remainder;
  }

  const sessionId = lines
    .flatMap((line) => parseRuntimeSessionId(runtime, line))
    [0];

  if (sessionId === undefined) {
    return remainder;
  }

  const now = new Date().toISOString();
  const ref = {
    runtime,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };

  writeRuntimeSessionRef(run.sessionDir, ref);
  writeRunRuntimeSessionRef(run.runDir, ref);
  appendRuntimeEvent(run, "runtime.session_started", {
    runtime,
    runtimeSessionRef: ref,
  });
  return remainder;
}

function parseRuntimeSessionId(runtime: RuntimeName, line: string): string[] {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      thread_id?: unknown;
      session_id?: unknown;
      sessionId?: unknown;
      conversation_id?: unknown;
    };

    if (runtime === "codex") {
      return parsed.type === "thread.started" && typeof parsed.thread_id === "string" ? [parsed.thread_id] : [];
    }

    for (const value of [parsed.session_id, parsed.sessionId, parsed.thread_id, parsed.conversation_id]) {
      if (typeof value === "string" && value.length > 0) {
        return [value];
      }
    }

    return [];
  } catch {
    return [];
  }
}

function writeRunRuntimeSessionRef(runDir: string, runtimeSessionRef: RuntimeSessionRef): void {
  const path = join(runDir, "metadata.json");

  if (!existsSync(path)) {
    return;
  }

  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({
      ...metadata,
      runtimeSessionRef,
    }, null, 2)}\n`, "utf8");
  } catch {
    // Metadata is best-effort runtime context; keep the run result path moving.
  }
}

function writeRuntimeSessionRef(sessionDir: string, runtimeSessionRef: RuntimeSessionRef): void {
  writeFileSync(join(sessionDir, "runtime-session.json"), `${JSON.stringify(runtimeSessionRef, null, 2)}\n`, "utf8");
}

function writeRunRuntimeProcess(runDir: string, runtimePid: number): void {
  const path = join(runDir, "metadata.json");

  if (!existsSync(path)) {
    return;
  }

  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({
      ...metadata,
      runtimePid,
    }, null, 2)}\n`, "utf8");
  } catch {
    // Metadata is best-effort runtime context; keep the run result path moving.
  }
}

function runStreamingCommand(input: AgentRunInput, preparedInput: PreparedRuntimeInput): Promise<RuntimeCommandResult> {
  return new Promise((resolve) => {
    writeFileSync(input.run.stdoutPath, "", "utf8");
    writeFileSync(input.run.stderrPath, "", "utf8");

    const child = spawn(preparedInput.command[0] ?? "codex", preparedInput.command.slice(1), {
      cwd: input.run.worktreePath,
      env: preparedInput.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      writeRunRuntimeProcess(input.run.runDir, child.pid);
    }
    const event = {
      run: input.run,
      issue: input.issue,
      command: preparedInput.command,
      startedAt: preparedInput.startedAt,
    };
    let canceled = false;
    let finished = false;
    let checking = false;
    let stdoutTail = "";
    let stderrTail = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      appendFileSync(input.run.stdoutPath, chunk);
      stdoutTail = appendBoundedTail(stdoutTail, chunk);
      stdoutLineBuffer = captureStreamingRuntimeSessionRef(preparedInput.runtime, stdoutLineBuffer, chunk.toString("utf8"), input.run);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendFileSync(input.run.stderrPath, chunk);
      stderrTail = appendBoundedTail(stderrTail, chunk);
      stderrLineBuffer = captureStreamingRuntimeSessionRef(preparedInput.runtime, stderrLineBuffer, chunk.toString("utf8"), input.run);
    });
    child.stdin.end(preparedInput.prompt);

    const cancelChild = () => {
      if (finished || canceled) {
        return;
      }

      canceled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    };

    const heartbeat = async () => {
      if (checking || finished) {
        return;
      }

      checking = true;

      try {
        await input.monitor?.onHeartbeat?.(event);

        if ((await input.monitor?.shouldCancel?.(event)) === true) {
          cancelChild();
        }
      } finally {
        checking = false;
      }
    };

    const timer = setInterval(() => {
      void heartbeat();
    }, input.monitor?.heartbeatIntervalMs ?? 10_000);

    child.on("error", (error) => {
      finished = true;
      clearInterval(timer);
      appendFileSync(input.run.stderrPath, `${error.message}\n`, "utf8");
      stderrTail = appendBoundedTail(stderrTail, Buffer.from(`${error.message}\n`));
      resolve({
        exitCode: 1,
        stdout: stdoutTail,
        stderr: stderrTail,
        canceled,
        streamed: true,
      });
    });

    child.on("close", (code, signal) => {
      finished = true;
      clearInterval(timer);
      resolve({
        exitCode: code ?? 130,
        stdout: stdoutTail,
        stderr: stderrTail,
        signal: signal ?? undefined,
        canceled,
        streamed: true,
      });
    });
  });
}

const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024;

function appendBoundedTail(current: string, chunk: Buffer): string {
  const next = `${current}${chunk.toString("utf8")}`;

  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return next;
  }

  return next.slice(next.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function appendRuntimeEvent(run: PreparedRun, type: string, data: Record<string, unknown>): void {
  writeFileSync(
    run.eventsPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      data,
    })}\n`,
    {
      encoding: "utf8",
      flag: "a",
    },
  );
}
