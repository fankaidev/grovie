import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RepositoryFileResult } from "./config.js";
import { SpawnCommandRunner, type CommandRunner } from "./github.js";
import type { AgentMetadata } from "./identity.js";

export type LocalStatePaths = {
  root: string;
  reposDir: string;
  worktreesDir: string;
  runsDir: string;
  agentsDir: string;
  locksDir: string;
  requestsDir: string;
  sessionsDir: string;
};

export type PrepareRunInput = {
  repository: string;
  issueNumber: number;
  agentId: string;
  defaultBranch: string;
  branchPrefix: string;
  now?: Date;
  prompt: string;
  task: Record<string, unknown>;
  runRequest?: {
    sourceRunId?: string;
    reason?: RunRequest["reason"];
  };
};

export type PreparedRun = {
  sessionId: string;
  runId: string;
  agentId: string;
  branchName: string;
  sessionDir: string;
  repositoryCachePath: string;
  worktreePath: string;
  runDir: string;
  taskPath: string;
  promptPath: string;
  eventsPath: string;
  stdoutPath: string;
  stderrPath: string;
};

export type LocalStateOptions = {
  paths?: Partial<LocalStatePaths>;
  runner?: CommandRunner;
};

export type DaemonLock = {
  machineId: string;
  pid: number;
  acquiredAt: string;
  path: string;
};

export type ExecutionLock = {
  repository: string;
  issueNumber: number;
  agentId: string;
  acquiredAt: string;
  path: string;
};

export type HandledCursor = {
  repository: string;
  issueNumber: number;
  agentId: string;
  handledThrough: string;
  issueFingerprint?: string;
  updatedAt: string;
};

export type RunRequest = {
  id: string;
  repository: string;
  issueNumber: number;
  agentId: string;
  createdAt: string;
  path: string;
  sourceRunId?: string;
  reason?: "manual" | "retry" | "rerun" | "resume";
};

export type RunCancellation = {
  runId: string;
  requestedAt: string;
  reason: string;
  path: string;
};

export type ResumableRun = {
  runId: string;
  repository: string;
  issueNumber: number;
  agentId: string;
  status: "interrupted" | "active-looking";
  runDir: string;
  worktreePath?: string;
};

export type LockResult<T> =
  | {
    ok: true;
    lock: T;
    recoveredStale?: boolean;
  }
  | {
    ok: false;
    message: string;
  };

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
    mkdirSync(this.paths.agentsDir, { recursive: true });
    mkdirSync(this.paths.locksDir, { recursive: true });
    mkdirSync(this.paths.requestsDir, { recursive: true });
    mkdirSync(this.paths.sessionsDir, { recursive: true });
  }

  registerAgent(metadata: AgentMetadata): void {
    this.ensureBaseDirectories();
    writeJsonFile(join(this.paths.agentsDir, `${sanitizePathPart(metadata.agentId)}.json`), metadata);
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
        || hasTerminalRunEvent(join(runDir, "events.jsonl"))
        || !isRecoverableRunMetadata(metadata, "active-looking")
      ) {
        continue;
      }

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
      this.releaseExecutionLock({
        repository: metadata.repository,
        issueNumber: metadata.issueNumber,
        agentId: metadata.agentId,
        acquiredAt: "",
        path: this.getExecutionLockPath(metadata.repository, metadata.issueNumber, metadata.agentId),
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

      if (metadata === undefined || metadata.repository !== input.repository || hasTerminalRunEvent(eventsPath)) {
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

      const repository = metadata.repository;
      const issueNumber = metadata.issueNumber;
      const agentId = metadata.agentId;
      const runId = metadata.runId ?? runDirName;
      const resumingAt = (input.now ?? new Date()).toISOString();
      writeJsonFile(metadataPath, {
        ...metadata,
        status: "resuming",
        resumeEligible: true,
        resumingAt,
      });
      appendRunEvent({ eventsPath }, "run.resuming", {
        reason: "daemon restart recovery",
      });
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

  cleanupSuccessfulWorktree(run: PreparedRun): void {
    if (!existsSync(run.worktreePath)) {
      return;
    }

    const result = this.runner.run("git", ["-C", run.repositoryCachePath, "worktree", "remove", "--force", run.worktreePath]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `git worktree remove failed with exit code ${result.exitCode}.`);
    }

    appendRunEvent(run, "worktree.cleaned", {
      worktreePath: run.worktreePath,
    });
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

type RunMetadata = {
  status?: string;
  runId?: string;
  repository?: string;
  issueNumber?: number;
  agentId?: string;
  worktreePath?: string;
  resumeEligible?: boolean;
};

export function resolvePaths(overrides: Partial<LocalStatePaths> = {}): LocalStatePaths {
  const root = overrides.root ?? join(homedir(), ".grovie");

  return {
    root,
    reposDir: overrides.reposDir ?? join(root, "repos"),
    worktreesDir: overrides.worktreesDir ?? join(root, "worktrees"),
    runsDir: overrides.runsDir ?? join(root, "runs"),
    agentsDir: overrides.agentsDir ?? join(root, "agents"),
    locksDir: overrides.locksDir ?? join(root, "locks"),
    requestsDir: overrides.requestsDir ?? join(root, "requests"),
    sessionsDir: overrides.sessionsDir ?? join(root, "sessions"),
  };
}

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

export function buildSessionId(repository: string, issueNumber: number, agentId: string): string {
  return `${sanitizeRepository(repository)}-issue-${issueNumber}-${sanitizePathPart(agentId)}`;
}

export function buildRunId(sessionId: string, runTimestamp = buildRunTimestamp()): string {
  return `${sanitizePathPart(sessionId)}-${sanitizePathPart(runTimestamp)}`;
}

export function buildBranchName(branchPrefix: string, sessionId: string): string {
  const normalizedPrefix = branchPrefix.endsWith("/") ? branchPrefix : `${branchPrefix}/`;
  return `${normalizedPrefix}${sanitizePathPart(sessionId)}`;
}

export function buildLocalBranchName(branchPrefix: string, sessionId: string): string {
  return buildBranchName(branchPrefix, sessionId);
}

export function buildRunTimestamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function sanitizeRepository(repository: string): string {
  return repository.replace(/[^A-Za-z0-9._-]/g, "-");
}

function getRunCancellationPath(paths: LocalStatePaths, runId: string): string {
  return join(paths.runsDir, sanitizePathPart(runId), "cancel.json");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function readdirRequestFiles(path: string): string[] {
  try {
    return readdirSync(path).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function readdirDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function isRecoverableRunMetadata(metadata: RunMetadata, mode: "interrupted" | "active-looking"): metadata is RunMetadata & {
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

function hasRunIdentity(metadata: RunMetadata): metadata is RunMetadata & {
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

function hasTerminalRunEvent(path: string): boolean {
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

function appendRunEvent(run: Pick<PreparedRun, "eventsPath">, type: string, data: Record<string, unknown> = {}): void {
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

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function removeFileIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function isLivePid(pid: unknown): boolean {
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
