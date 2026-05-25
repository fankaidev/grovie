import { join } from "node:path";
import { isRunCancellationRequested } from "./cancellation.js";
import { appendRunEvent, hasRunIdentity, hasTerminalRunEvent, interruptRuntimeProcess, isLivePid, isRecoverableRunMetadata } from "./events.js";
import { readJsonFile, readdirDirectoryNames, writeJsonFile } from "./files.js";
import { sanitizePathPart } from "./ids.js";
import { getExecutionLockPath, releaseExecutionLock } from "./locks.js";
import type { LocalStatePaths, ResumableRun, RunMetadata } from "./types.js";

export function interruptActiveRuns(paths: LocalStatePaths, input: { now?: Date; reason: string }): ResumableRun[] {
  const interrupted: ResumableRun[] = [];

  for (const runDirName of readdirDirectoryNames(paths.runsDir)) {
    const runDir = join(paths.runsDir, runDirName);
    const metadataPath = join(runDir, "metadata.json");
    const metadata = readJsonFile<RunMetadata>(metadataPath);

    if (
      metadata === undefined
      || (metadata.status !== "interrupted" && metadata.status !== "resuming" && hasTerminalRunEvent(join(runDir, "events.jsonl")))
      || !isRecoverableRunMetadata(metadata, "active-looking")
    ) {
      continue;
    }

    interruptRuntimeProcess(metadata.runtimePid);
    const runId = metadata.runId ?? runDirName;
    const interruptedAt = (input.now ?? new Date()).toISOString();
    writeJsonFile(metadataPath, {
      ...metadata,
      status: "interrupted",
      resumeEligible: true,
      interruptedAt,
      interruptReason: input.reason,
    });
    appendRunEvent({ eventsPath: join(runDir, "events.jsonl") }, "run.interrupted", {
      reason: input.reason,
      resumeEligible: true,
    });
    interrupted.push({
      runId,
      repository: metadata.repository,
      issueNumber: metadata.issueNumber,
      agentId: metadata.agentId,
      status: "interrupted",
      runDir,
      worktreePath: metadata.worktreePath,
    });
  }

  return interrupted;
}

export function takeResumableRun(paths: LocalStatePaths, input: { repository: string; now?: Date }): ResumableRun | undefined {
  for (const runDirName of readdirDirectoryNames(paths.runsDir)) {
    const runDir = join(paths.runsDir, runDirName);
    const metadataPath = join(runDir, "metadata.json");
    const eventsPath = join(runDir, "events.jsonl");
    const metadata = readJsonFile<RunMetadata>(metadataPath);

    if (
      metadata === undefined
      || metadata.repository !== input.repository
      || (metadata.status !== "interrupted" && metadata.status !== "resuming" && hasTerminalRunEvent(eventsPath))
    ) {
      continue;
    }

    if (!hasRunIdentity(metadata)) {
      continue;
    }

    const status = isRecoverableRunMetadata(metadata, "interrupted")
      ? "interrupted"
      : isRecoverableRunMetadata(metadata, "active-looking")
        ? "active-looking"
        : undefined;

    if (status === undefined || isRunCancellationRequested(paths, metadata.runId ?? runDirName)) {
      continue;
    }

    if (isLivePid(metadata.runtimePid)) {
      continue;
    }

    const repository = metadata.repository;
    const issueNumber = metadata.issueNumber;
    const agentId = metadata.agentId;
    const runId = metadata.runId ?? runDirName;
    releaseExecutionLock({
      repository,
      issueNumber,
      agentId,
      acquiredAt: "",
      path: getExecutionLockPath(paths, repository, issueNumber, agentId),
    });

    return {
      runId,
      repository,
      issueNumber,
      agentId,
      status,
      runDir,
      worktreePath: metadata.worktreePath,
    };
  }

  return undefined;
}

export function markSessionResuming(paths: LocalStatePaths, input: { sourceRunId: string; now?: Date; reason: string }): void {
  const runDir = join(paths.runsDir, sanitizePathPart(input.sourceRunId));
  const metadataPath = join(runDir, "metadata.json");
  const metadata = readJsonFile<RunMetadata>(metadataPath);

  if (metadata === undefined) {
    return;
  }

  writeJsonFile(metadataPath, {
    ...metadata,
    status: metadata.status === "resuming" ? "interrupted" : metadata.status,
    resumeEligible: false,
    sessionResumingAt: (input.now ?? new Date()).toISOString(),
  });
  appendRunEvent({ eventsPath: join(runDir, "events.jsonl") }, "session.resuming", {
    reason: input.reason,
  });
}

export function markRunRejected(paths: LocalStatePaths, input: { runId: string; now?: Date; reason: string }): void {
  const runDir = join(paths.runsDir, sanitizePathPart(input.runId));
  const metadataPath = join(runDir, "metadata.json");
  const metadata = readJsonFile<RunMetadata>(metadataPath);

  if (metadata === undefined) {
    return;
  }

  writeJsonFile(metadataPath, {
    ...metadata,
    status: "rejected",
    resumeEligible: false,
    rejectedAt: (input.now ?? new Date()).toISOString(),
    rejectReason: input.reason,
  });
  appendRunEvent({ eventsPath: join(runDir, "events.jsonl") }, "run.rejected", {
    reason: input.reason,
  });
}
