import { existsSync } from "node:fs";
import { join } from "node:path";
import { isLivePid } from "./events.js";
import { readJsonFile, removeFileIfExists, writeJsonFile } from "./files.js";
import { sanitizePathPart } from "./ids.js";
import type { DaemonLock, ExecutionLock, LocalStatePaths, LockResult } from "./types.js";

export function acquireDaemonLock(paths: LocalStatePaths, machineId: string, now = new Date()): LockResult<DaemonLock> {
  const path = getDaemonLockPath(paths, machineId);
  const existing = readJsonFile<Partial<DaemonLock>>(path);
  const recoveredStale = existing !== undefined && !isLivePid(existing.pid);

  if (existing !== undefined && !recoveredStale) {
    return {
      ok: false,
      message: `Grovie daemon already appears to be running for machine ${machineId} with pid ${existing.pid}.`,
    };
  }

  const lock = {
    machineId,
    pid: process.pid,
    acquiredAt: now.toISOString(),
    path,
  };

  writeJsonFile(path, lock);

  return {
    ok: true,
    lock,
    recoveredStale,
  };
}

export function releaseDaemonLock(lock: DaemonLock): void {
  removeFileIfExists(lock.path);
}

export function isDaemonRunning(paths: LocalStatePaths, machineId: string): boolean {
  const existing = readJsonFile<Partial<DaemonLock>>(getDaemonLockPath(paths, machineId));
  return existing !== undefined && isLivePid(existing.pid);
}

export function acquireExecutionLock(
  paths: LocalStatePaths,
  input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    now?: Date;
  },
): LockResult<ExecutionLock> {
  const path = getExecutionLockPath(paths, input.repository, input.issueNumber, input.agentId);
  const existing = readJsonFile<Partial<ExecutionLock>>(path);

  if (existing !== undefined) {
    return {
      ok: false,
      message: `Grovie execution already appears active for ${input.repository}#${input.issueNumber} and ${input.agentId}.`,
    };
  }

  const lock = {
    repository: input.repository,
    issueNumber: input.issueNumber,
    agentId: input.agentId,
    acquiredAt: (input.now ?? new Date()).toISOString(),
    path,
  };

  writeJsonFile(path, lock);

  return {
    ok: true,
    lock,
  };
}

export function hasExecutionLock(paths: LocalStatePaths, input: { repository: string; issueNumber: number; agentId: string }): boolean {
  return existsSync(getExecutionLockPath(paths, input.repository, input.issueNumber, input.agentId));
}

export function releaseExecutionLock(lock: ExecutionLock): void {
  removeFileIfExists(lock.path);
}

export function getExecutionLockPath(paths: LocalStatePaths, repository: string, issueNumber: number, agentId: string): string {
  return join(
    paths.locksDir,
    `execution-${sanitizePathPart(repository)}-issue-${issueNumber}-${sanitizePathPart(agentId)}.json`,
  );
}

function getDaemonLockPath(paths: LocalStatePaths, machineId: string): string {
  return join(paths.locksDir, `daemon-${sanitizePathPart(machineId)}.json`);
}
