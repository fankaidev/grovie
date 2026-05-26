import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpawnCommandRunner, type CommandRunner } from "../github.js";
import { getRunCancellationPath, isRunCancellationRequested, writeRunCancellation } from "./cancellation.js";
import { appendRunEvent, toErrorMessage } from "./events.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { buildBranchName, buildRunId, buildRunTimestamp, buildSessionId, sanitizePathPart } from "./ids.js";
import { acquireDaemonLock, acquireExecutionLock, hasExecutionLock, isDaemonRunning, releaseDaemonLock, releaseExecutionLock } from "./locks.js";
import { resolvePaths } from "./paths.js";
import { interruptActiveRuns, markRunRejected, markSessionResuming, takeResumableRun } from "./resume.js";
import { ensureRepositoryCache, ensureWorktree, getRepositoryCachePath } from "./repository.js";
import type { DaemonLock, ExecutionLock, HandledCursor, LocalStateOptions, LocalStatePaths, LockResult, PreparedRun, PrepareRunInput, ResumableRun, RunCancellation } from "./types.js";

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
    mkdirSync(this.paths.sessionsDir, { recursive: true });
  }
  acquireDaemonLock(machineId: string, now = new Date()): LockResult<DaemonLock> {
    this.ensureBaseDirectories();
    return acquireDaemonLock(this.paths, machineId, now);
  }

  releaseDaemonLock(lock: DaemonLock): void {
    releaseDaemonLock(lock);
  }

  isDaemonRunning(machineId: string): boolean {
    return isDaemonRunning(this.paths, machineId);
  }

  acquireExecutionLock(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    now?: Date;
  }): LockResult<ExecutionLock> {
    this.ensureBaseDirectories();
    return acquireExecutionLock(this.paths, input);
  }

  hasExecutionLock(input: { repository: string; issueNumber: number; agentId: string }): boolean {
    return hasExecutionLock(this.paths, input);
  }

  releaseExecutionLock(lock: ExecutionLock): void {
    releaseExecutionLock(lock);
  }

  interruptActiveRuns(input: { now?: Date; reason: string }): ResumableRun[] {
    this.ensureBaseDirectories();
    return interruptActiveRuns(this.paths, input);
  }

  takeResumableRun(input: { repository: string; now?: Date }): ResumableRun | undefined {
    this.ensureBaseDirectories();
    return takeResumableRun(this.paths, input);
  }

  markSessionResuming(input: { sourceRunId: string; now?: Date; reason: string }): void {
    markSessionResuming(this.paths, input);
  }

  markRunRejected(input: { runId: string; now?: Date; reason: string }): void {
    markRunRejected(this.paths, input);
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
    const repositoryCachePath = getRepositoryCachePath(this.paths, input.repository);
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
      ensureRepositoryCache({
        paths: this.paths,
        runner: this.runner,
        repository: input.repository,
        defaultBranch: input.defaultBranch,
      });
      ensureWorktree({
        runner: this.runner,
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

  private getHandledCursorPath(repository: string, issueNumber: number, agentId: string): string {
    return join(
      this.paths.sessionsDir,
      `${sanitizePathPart(repository)}-issue-${issueNumber}-${sanitizePathPart(agentId)}.json`,
    );
  }

}
