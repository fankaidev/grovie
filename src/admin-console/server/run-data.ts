import { existsSync, readFileSync } from "node:fs";
import type { AdminLogStream } from "../../admin-api.js";
import type { LocalRunSummary } from "../../status.js";

export function readRunLog(run: LocalRunSummary, stream: AdminLogStream): { path: string; content: string } {
  const path = stream === "stdout" ? run.stdoutPath : run.stderrPath;

  return {
    path,
    content: readLocalTextFile(path),
  };
}

export function readLocalTextFile(path: string): string {
  if (!existsSync(path)) {
    return "";
  }

  return readFileSync(path, "utf8");
}

export function isLogStream(value: string | undefined): value is "stdout" | "stderr" {
  return value === "stdout" || value === "stderr";
}

export function isCancelableRun(run: LocalRunSummary): boolean {
  return run.status === "preparing" || run.status === "prepared" || run.status === "running" || run.status === "stale";
}
