import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { PreparedRun, RunMetadata } from "./types.js";

export function isRecoverableRunMetadata(metadata: RunMetadata, mode: "interrupted" | "active-looking"): metadata is RunMetadata & {
  repository: string;
  issueNumber: number;
  agentId: string;
} {
  if (!hasRunIdentity(metadata)) {
    return false;
  }

  if (mode === "interrupted") {
    return metadata.status === "interrupted" && metadata.resumeEligible === true;
  }

  return metadata.status === "preparing" || metadata.status === "prepared" || metadata.status === "running";
}

export function hasRunIdentity(metadata: RunMetadata): metadata is RunMetadata & {
  repository: string;
  issueNumber: number;
  agentId: string;
} {
  return (
    typeof metadata.repository === "string"
    && typeof metadata.issueNumber === "number"
    && typeof metadata.agentId === "string"
  );
}

export function hasTerminalRunEvent(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => {
      try {
        const parsed = JSON.parse(line) as { type?: unknown };
        return parsed.type === "prepare.failed"
          || parsed.type === "runtime.finished"
          || parsed.type === "run.succeeded"
          || parsed.type === "run.failed"
          || parsed.type === "run.canceled";
      } catch {
        return false;
      }
    });
}

export function interruptRuntimeProcess(pid: unknown): void {
  if (typeof pid !== "number" || !isLivePid(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Best-effort runtime interruption; recovery will avoid live pids.
  }
}

export function appendRunEvent(run: Pick<PreparedRun, "eventsPath">, type: string, data: Record<string, unknown> = {}): void {
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

export function isLivePid(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
