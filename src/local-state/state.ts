import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryFileResult } from "../config.js";
import { SpawnCommandRunner, type CommandRunner } from "../github.js";
import { getRunCancellationPath, isRunCancellationRequested, writeRunCancellation } from "./cancellation.js";
import { appendRunEvent, hasRunIdentity, hasTerminalRunEvent, interruptRuntimeProcess, isLivePid, isRecoverableRunMetadata, toErrorMessage } from "./events.js";
import { readJsonFile, readdirDirectoryNames, readdirRequestFiles, removeFileIfExists, writeJsonFile } from "./files.js";
import { buildBranchName, buildRunId, buildRunTimestamp, buildSessionId, sanitizePathPart, sanitizeRepository } from "./ids.js";
import { resolvePaths } from "./paths.js";
import type { DaemonLock, ExecutionLock, HandledCursor, LocalStateOptions, LocalStatePaths, LockResult, PreparedRun, PrepareRunInput, ResumableRun, RunCancellation, RunMetadata, RunRequest } from "./types.js";

export class LocalState {
  private readonly paths: LocalStatePaths;
  private readonly runner: CommandRunner;

  constructor(options: LocalStateOptions = {}) {
    this.paths = resolvePaths(options.paths);
    this.runner = options.runner ?? new SpawnCommandRunner();
  }

  getPaths(): LocalStatePaths {
    return this.paths;
  }

  ensureBaseDirectories(): void {
    mkdirSync(this.paths.root, { recursive: true });
    mkdirSync(this.paths.reposDir, { recursive: true });
    mkdirSync(this.paths.worktreesDir, { recursive: true });
    mkdirSync(this.paths.runsDir, { recursive: true });
    mkdirSync(this.paths.locksDir, { recursive: true });
    mkdirSync(this.paths.requestsDir, { recursive: true });
    mkdirSync(this.paths.sessionsDir, { recursive: true });
  }
  acquireDaemonLock(machineId: string, now = new Date()): LockResult<DaemonLock> {
    this.ensureBaseDirectories();
    const path = join(this.paths.locksDir, `daemon-${sanitizePathPart(machineId)}.json`);
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

  releaseDaemonLock(lock: DaemonLock): void {
    removeFileIfExists(lock.path);
  }

  isDaemonRunning(machineId: string): boolean {
    const existing = readJsonFile<Partial<DaemonLock>>(join(this.paths.locksDir, `daemon-${sanitizePathPart(machineId)}.json`));
    return existing !== undefined && isLivePid(existing.pid);
  }

  acquireExecutionLock(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    now?: Date;
  }): LockResult<ExecutionLock> {
    this.ensureBaseDirectories();
    const path = this.getExecutionLockPath(input.repository, input.issueNumber, input.agentId);
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

  hasExecutionLock(input: { repository: string; issueNumber: number; agentId: string }): boolean {
    return existsSync(this.getExecutionLockPath(input.repository, input.issueNumber, input.agentId));
  }

  releaseExecutionLock(lock: ExecutionLock): void {
    removeFileIfExists(lock.path);
  }

  interruptActiveRuns(input: { now?: Date; reason: string }): ResumableRun[] {
    this.ensureBaseDirectories();
    const interrupted: ResumableRun[] = [];

    for (const runDirName of readdirDirectoryNames(this.paths.runsDir)) {
      const runDir = join(this.paths.runsDir, runDirName);
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

  takeResumableRun(input: { repository: string; now?: Date }): ResumableRun | undefined {
    this.ensureBaseDirectories();

    for (const runDirName of readdirDirectoryNames(this.paths.runsDir)) {
      const runDir = join(this.paths.runsDir, runDirName);
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

      if (status === undefined || isRunCancellationRequested(this.paths, metadata.runId ?? runDirName)) {
        continue;
      }

      if (isLivePid(metadata.runtimePid)) {
        continue;
      }

      const repository = metadata.repository;
      const issueNumber = metadata.issueNumber;
      const agentId = metadata.agentId;
      const runId = metadata.runId ?? runDirName;
      this.releaseExecutionLock({
        repository,
        issueNumber,
        agentId,
        acquiredAt: "",
        path: this.getExecutionLockPath(repository, issueNumber, agentId),
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

  markSessionResuming(input: { sourceRunId: string; now?: Date; reason: string }): void {
    const runDir = join(this.paths.runsDir, sanitizePathPart(input.sourceRunId));
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

  markRunRejected(input: { runId: string; now?: Date; reason: string }): void {
    const runDir = join(this.paths.runsDir, sanitizePathPart(input.runId));
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

  enqueueRunRequest(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    now?: Date;
    sourceRunId?: string;
    reason?: RunRequest["reason"];
  }): RunRequest {
    this.ensureBaseDirectories();
    const createdAt = (input.now ?? new Date()).toISOString();
    const id = [
      buildRunTimestamp(new Date(createdAt)),
      sanitizePathPart(input.repository),
      `issue-${input.issueNumber}`,
      sanitizePathPart(input.agentId),
    ].join("-");
    const requestPath = this.getRunRequestPath(id);
    const request = {
      id: requestPath.id,
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.agentId,
      createdAt,
      path: requestPath.path,
      sourceRunId: input.sourceRunId,
      reason: input.reason,
    };

    writeJsonFile(requestPath.path, request);
    return request;
  }

  takeRunRequest(repository: string): RunRequest | undefined {
    this.ensureBaseDirectories();
    const entries = readdirRequestFiles(this.paths.requestsDir);

    for (const entry of entries) {
      const request = readJsonFile<RunRequest>(join(this.paths.requestsDir, entry));

      if (request?.repository !== repository) {
        continue;
      }

      removeFileIfExists(join(this.paths.requestsDir, entry));
      return {
        ...request,
        path: join(this.paths.requestsDir, entry),
      };
    }

    return undefined;
  }

  requestRunCancellation(input: { runId: string; reason?: string; now?: Date }): RunCancellation {
    this.ensureBaseDirectories();
    return writeRunCancellation(this.paths, input);
  }

  isRunCancellationRequested(runId: string): boolean {
    return existsSync(getRunCancellationPath(this.paths, runId));
  }

  readHandledCursor(input: { repository: string; issueNumber: number; agentId: string }): HandledCursor | undefined {
    return readJsonFile<HandledCursor>(this.getHandledCursorPath(input.repository, input.issueNumber, input.agentId));
  }

  writeHandledCursor(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    handledThrough: string;
    issueFingerprint?: string;
    now?: Date;
  }): HandledCursor {
    this.ensureBaseDirectories();
    const cursor = {
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.agentId,
      handledThrough: input.handledThrough,
      issueFingerprint: input.issueFingerprint,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };

    writeJsonFile(this.getHandledCursorPath(input.repository, input.issueNumber, input.agentId), cursor);
    return cursor;
  }

  prepareRun(input: PrepareRunInput): PreparedRun {
    this.ensureBaseDirectories();

    const now = input.now ?? new Date();
    const sessionId = buildSessionId(input.repository, input.issueNumber, input.agentId);
    const runId = buildRunId(sessionId, buildRunTimestamp(now));
    const branchName = buildBranchName(input.branchPrefix, sessionId);
    const localBranchName = branchName;
    const repositoryCachePath = this.getRepositoryCachePath(input.repository);
    const sessionDir = join(this.paths.sessionsDir, sessionId);
    const worktreePath = join(this.paths.worktreesDir, sessionId);
    const runDir = join(this.paths.runsDir, runId);
    const eventsPath = join(runDir, "events.jsonl");
    const taskPath = join(runDir, "task.json");
    const promptPath = join(runDir, "prompt.md");
    const stdoutPath = join(runDir, "stdout.log");
    const stderrPath = join(runDir, "stderr.log");
    const createdAt = now.toISOString();

    if (existsSync(runDir)) {
      throw new Error(`Run id ${runId} already exists. Retry after the current UTC second or inspect ${runDir}.`);
    }

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeJsonFile(join(sessionDir, "session.json"), {
      sessionId,
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.agentId,
      branchName,
      worktreePath,
      updatedAt: createdAt,
    });
    writeJsonFile(taskPath, input.task);
    writeFileSync(promptPath, input.prompt, "utf8");
    writeFileSync(eventsPath, "", { encoding: "utf8", flag: "a" });
    writeFileSync(stdoutPath, "", { encoding: "utf8", flag: "a" });
    writeFileSync(stderrPath, "", { encoding: "utf8", flag: "a" });

    const preparedRun = {
      sessionId,
      runId,
      agentId: input.agentId,
      branchName,
      sessionDir,
      repositoryCachePath,
      worktreePath,
      runDir,
      taskPath,
      promptPath,
      eventsPath,
      stdoutPath,
      stderrPath,
    };

    writeJsonFile(join(runDir, "metadata.json"), {
      status: "preparing",
      sessionId,
      runId,
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.agentId,
      branchName,
      localBranchName,
      sessionDir,
      defaultBranch: input.defaultBranch,
      repositoryCachePath,
      worktreePath,
      runRequest: input.runRequest,
      createdAt,
    });

    appendRunEvent(preparedRun, "prepare.started", {
      repository: input.repository,
      issueNumber: input.issueNumber,
      branchName,
    });

    try {
      this.ensureRepositoryCache(input.repository, input.defaultBranch);
      this.ensureWorktree({
        repositoryCachePath,
        worktreePath,
        branchName: localBranchName,
        baseBranch: input.defaultBranch,
      });

      writeJsonFile(join(runDir, "metadata.json"), {
        status: "prepared",
        sessionId,
        runId,
        repository: input.repository,
        issueNumber: input.issueNumber,
        agentId: input.agentId,
        branchName,
        localBranchName,
        sessionDir,
        defaultBranch: input.defaultBranch,
        repositoryCachePath,
        worktreePath,
        runRequest: input.runRequest,
        createdAt,
        preparedAt: new Date().toISOString(),
      });
      appendRunEvent(preparedRun, "prepared", {
        repository: input.repository,
        issueNumber: input.issueNumber,
        branchName,
      });
    } catch (error) {
      appendRunEvent(preparedRun, "prepare.failed", {
        message: toErrorMessage(error),
      });
      throw error;
    }

    return preparedRun;
  }

  appendEvent(run: PreparedRun, type: string, data: Record<string, unknown> = {}): void {
    appendRunEvent(run, type, data);
  }

  readTask(run: PreparedRun): unknown {
    return JSON.parse(readFileSync(run.taskPath, "utf8"));
  }

  readRepositoryFile(input: { repository: string; path: string }): RepositoryFileResult {
    this.ensureBaseDirectories();
    const { cachePath, ref } = this.ensureRepositoryCacheAtRemoteHead(input.repository);
    const result = this.runner.run("git", ["-C", cachePath, "show", `${ref}:${input.path}`]);
    const path = `${input.repository}:${input.path}`;

    if (result.exitCode === 0) {
      return {
        exists: true,
        path,
        content: result.stdout,
      };
    }

    if (
      result.stderr.includes("exists on disk, but not in") ||
      result.stderr.includes("Path ") ||
      result.stderr.includes("does not exist")
    ) {
      return {
        exists: false,
        path,
      };
    }

    throw new Error(result.stderr.trim() || `git show failed with exit code ${result.exitCode}.`);
  }

  private getRunRequestPath(id: string): { id: string; path: string } {
    let candidate = id;
    let path = join(this.paths.requestsDir, `${candidate}.json`);
    let suffix = 2;

    while (existsSync(path)) {
      candidate = `${id}-${suffix}`;
      path = join(this.paths.requestsDir, `${candidate}.json`);
      suffix += 1;
    }

    return {
      id: candidate,
      path,
    };
  }

  private ensureRepositoryCache(repository: string, defaultBranch: string): string {
    const cachePath = this.getRepositoryCachePath(repository);
    const remoteUrl = `https://github.com/${repository}.git`;

    if (!existsSync(cachePath)) {
      const cloneResult = this.runner.run("git", ["clone", "--bare", remoteUrl, cachePath]);

      if (cloneResult.exitCode !== 0) {
        throw new Error(cloneResult.stderr.trim() || `git clone --bare failed with exit code ${cloneResult.exitCode}.`);
      }
    }

    const fetchResult = this.runner.run("git", [
      "-C",
      cachePath,
      "fetch",
      "origin",
      `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
    ]);

    if (fetchResult.exitCode !== 0) {
      throw new Error(fetchResult.stderr.trim() || `git fetch failed with exit code ${fetchResult.exitCode}.`);
    }

    return cachePath;
  }

  private ensureRepositoryCacheAtRemoteHead(repository: string): { cachePath: string; ref: string } {
    const cachePath = this.getRepositoryCachePath(repository);
    const remoteUrl = `https://github.com/${repository}.git`;

    if (!existsSync(cachePath)) {
      const cloneResult = this.runner.run("git", ["clone", "--bare", remoteUrl, cachePath]);

      if (cloneResult.exitCode !== 0) {
        throw new Error(cloneResult.stderr.trim() || `git clone --bare failed with exit code ${cloneResult.exitCode}.`);
      }
    }

    const ref = this.resolveRepositoryHeadRef(cachePath);
    const fetchResult = this.runner.run("git", [
      "-C",
      cachePath,
      "fetch",
      "origin",
      `+refs/heads/${ref}:refs/heads/${ref}`,
    ]);

    if (fetchResult.exitCode !== 0) {
      throw new Error(fetchResult.stderr.trim() || `git fetch failed with exit code ${fetchResult.exitCode}.`);
    }

    return {
      cachePath,
      ref,
    };
  }

  private resolveRepositoryHeadRef(repositoryCachePath: string): string {
    const remoteResult = this.runner.run("git", ["-C", repositoryCachePath, "ls-remote", "--symref", "origin", "HEAD"]);

    if (remoteResult.exitCode === 0) {
      const headLine = remoteResult.stdout
        .split("\n")
        .find((line) => line.startsWith("ref: refs/heads/") && line.endsWith("\tHEAD"));
      const branch = headLine?.replace(/^ref: refs\/heads\//, "").replace(/\tHEAD$/, "");

      if (branch !== undefined && branch.length > 0) {
        return branch;
      }
    }

    const result = this.runner.run("git", ["-C", repositoryCachePath, "symbolic-ref", "--short", "HEAD"]);

    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return result.stdout.trim();
    }

    return "main";
  }

  private getRepositoryCachePath(repository: string): string {
    return join(this.paths.reposDir, `${sanitizeRepository(repository)}.git`);
  }

  private getExecutionLockPath(repository: string, issueNumber: number, agentId: string): string {
    return join(
      this.paths.locksDir,
      `execution-${sanitizePathPart(repository)}-issue-${issueNumber}-${sanitizePathPart(agentId)}.json`,
    );
  }

  private getHandledCursorPath(repository: string, issueNumber: number, agentId: string): string {
    return join(
      this.paths.sessionsDir,
      `${sanitizePathPart(repository)}-issue-${issueNumber}-${sanitizePathPart(agentId)}.json`,
    );
  }

  private ensureWorktree(input: {
    repositoryCachePath: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
  }): void {
    if (existsSync(input.worktreePath)) {
      return;
    }

    const pruneResult = this.runner.run("git", ["-C", input.repositoryCachePath, "worktree", "prune"]);

    if (pruneResult.exitCode !== 0) {
      throw new Error(pruneResult.stderr.trim() || `git worktree prune failed with exit code ${pruneResult.exitCode}.`);
    }

    const result = this.runner.run("git", [
      "-C",
      input.repositoryCachePath,
      "worktree",
      "add",
      "-B",
      input.branchName,
      input.worktreePath,
      input.baseBranch,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `git worktree add failed with exit code ${result.exitCode}.`);
    }
  }
}
