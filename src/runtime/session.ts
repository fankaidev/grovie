import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedRun } from "../local-state.js";
import { appendRuntimeEvent } from "./events.js";
import type { RuntimeName, RuntimeSessionRef } from "./types.js";

export function readRuntimeSessionRef(sessionDir: string, runtime: RuntimeName): RuntimeSessionRef | undefined {
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

export function parseRuntimeSessionRef(
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

export function captureStreamingRuntimeSessionRef(
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

export function writeRunRuntimeSessionRef(runDir: string, runtimeSessionRef: RuntimeSessionRef): void {
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

export function writeRunRuntimeProcess(runDir: string, runtimePid: number): void {
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

function writeRuntimeSessionRef(sessionDir: string, runtimeSessionRef: RuntimeSessionRef): void {
  writeFileSync(join(sessionDir, "runtime-session.json"), `${JSON.stringify(runtimeSessionRef, null, 2)}\n`, "utf8");
}
