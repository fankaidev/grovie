import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalStatePaths } from "./local-state.js";

export type DaemonActivityEntry = {
  timestamp: string;
  type: string;
  message: string;
  repository?: string;
  issueNumber?: number;
  agentId?: string;
  data?: Record<string, unknown>;
};

export function appendDaemonActivity(
  paths: LocalStatePaths | undefined,
  entry: Omit<DaemonActivityEntry, "timestamp"> & { timestamp?: string },
): void {
  if (paths === undefined) {
    return;
  }

  const path = getDaemonActivityPath(paths);
  mkdirSync(join(paths.root, "daemon"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: entry.timestamp ?? new Date().toISOString(),
      type: entry.type,
      message: entry.message,
      repository: entry.repository,
      issueNumber: entry.issueNumber,
      agentId: entry.agentId,
      data: entry.data,
    })}\n`,
    {
      encoding: "utf8",
      flag: "a",
    },
  );
}

export function readDaemonActivity(paths: LocalStatePaths, limit = 50): DaemonActivityEntry[] {
  const path = getDaemonActivityPath(paths);

  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseDaemonActivityLine)
    .filter((entry): entry is DaemonActivityEntry => entry !== undefined)
    .slice(-limit)
    .reverse();
}

function getDaemonActivityPath(paths: LocalStatePaths): string {
  return join(paths.root, "daemon", "activity.jsonl");
}

function parseDaemonActivityLine(line: string): DaemonActivityEntry | undefined {
  try {
    const value = JSON.parse(line) as Partial<DaemonActivityEntry>;

    if (typeof value.timestamp !== "string" || typeof value.type !== "string" || typeof value.message !== "string") {
      return undefined;
    }

    return {
      timestamp: value.timestamp,
      type: value.type,
      message: value.message,
      repository: typeof value.repository === "string" ? value.repository : undefined,
      issueNumber: typeof value.issueNumber === "number" ? value.issueNumber : undefined,
      agentId: typeof value.agentId === "string" ? value.agentId : undefined,
      data: typeof value.data === "object" && value.data !== null ? value.data : undefined,
    };
  } catch {
    return undefined;
  }
}
