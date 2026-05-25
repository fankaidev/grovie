import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalStatePaths, RunCancellation } from "./types.js";
import { appendRunEvent } from "./events.js";
import { writeJsonFile } from "./files.js";
import { sanitizePathPart } from "./ids.js";

export function writeRunCancellation(
  paths: LocalStatePaths,
  input: { runId: string; reason?: string; now?: Date },
): RunCancellation {
  const runDir = join(paths.runsDir, sanitizePathPart(input.runId));
  const path = join(runDir, "cancel.json");
  const requestedAt = (input.now ?? new Date()).toISOString();
  const cancellation = {
    runId: input.runId,
    requestedAt,
    reason: input.reason ?? "Canceled from local admin console.",
    path,
  };

  if (!existsSync(runDir)) {
    throw new Error(`Run not found: ${input.runId}`);
  }

  writeJsonFile(path, cancellation);
  appendRunEvent({ eventsPath: join(runDir, "events.jsonl") }, "run.cancel_requested", {
    reason: cancellation.reason,
  });
  return cancellation;
}

export function isRunCancellationRequested(paths: LocalStatePaths, runId: string): boolean {
  return existsSync(getRunCancellationPath(paths, runId));
}

export function getRunCancellationPath(paths: LocalStatePaths, runId: string): string {
  return join(paths.runsDir, sanitizePathPart(runId), "cancel.json");
}
