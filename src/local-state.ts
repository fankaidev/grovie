import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SpawnCommandRunner, type CommandRunner } from "./github.js";
import type { AgentMetadata } from "./identity.js";

export type LocalStatePaths = {
  root: string;
  reposDir: string;
  worktreesDir: string;
  runsDir: string;
  agentsDir: string;
  locksDir: string;
  sessionsDir: string;
};

export type PrepareRunInput = {
  repository: string;
  issueNumber: number;
  defaultBranch: string;
  branchPrefix: string;
  attemptId?: string;
  prompt: string;
  task: Record<string, unknown>;
};

export type PreparedRun = {
  runId: string;
  branchName: string;
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

    const attemptId = input.attemptId ?? buildAttemptId();
    const runId = buildRunId(input.repository, input.issueNumber, attemptId);
    const branchName = buildBranchName(input.branchPrefix, input.issueNumber);
    const localBranchName = buildLocalBranchName(input.branchPrefix, input.issueNumber, attemptId);
    const repositoryCachePath = this.getRepositoryCachePath(input.repository);
    const worktreePath = join(this.paths.worktreesDir, runId);
    const runDir = join(this.paths.runsDir, runId);
    const eventsPath = join(runDir, "events.jsonl");
    const taskPath = join(runDir, "task.json");
    const promptPath = join(runDir, "prompt.md");
    const stdoutPath = join(runDir, "stdout.log");
    const stderrPath = join(runDir, "stderr.log");
    const createdAt = new Date().toISOString();

    mkdirSync(runDir, { recursive: true });
    writeJsonFile(taskPath, input.task);
    writeFileSync(promptPath, input.prompt, "utf8");
    writeFileSync(eventsPath, "", { encoding: "utf8", flag: "a" });
    writeFileSync(stdoutPath, "", { encoding: "utf8", flag: "a" });
    writeFileSync(stderrPath, "", { encoding: "utf8", flag: "a" });

    const preparedRun = {
      runId,
      branchName,
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
      runId,
      repository: input.repository,
      issueNumber: input.issueNumber,
      branchName,
      localBranchName,
      defaultBranch: input.defaultBranch,
      repositoryCachePath,
      worktreePath,
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
        runId,
        repository: input.repository,
        issueNumber: input.issueNumber,
        branchName,
        localBranchName,
        defaultBranch: input.defaultBranch,
        repositoryCachePath,
        worktreePath,
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
      const removeWorktree = this.runner.run("git", [
        "-C",
        input.repositoryCachePath,
        "worktree",
        "remove",
        "--force",
        input.worktreePath,
      ]);

      if (removeWorktree.exitCode !== 0) {
        rmSync(input.worktreePath, { recursive: true, force: true });
      }
    }

    const pruneResult = this.runner.run("git", ["-C", input.repositoryCachePath, "worktree", "prune"]);

    if (pruneResult.exitCode !== 0) {
      throw new Error(pruneResult.stderr.trim() || `git worktree prune failed with exit code ${pruneResult.exitCode}.`);
    }

    const deleteBranch = this.runner.run("git", ["-C", input.repositoryCachePath, "branch", "-D", input.branchName]);

    if (deleteBranch.exitCode !== 0 && !deleteBranch.stderr.includes("not found")) {
      throw new Error(deleteBranch.stderr.trim() || `git branch -D failed with exit code ${deleteBranch.exitCode}.`);
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

export function resolvePaths(overrides: Partial<LocalStatePaths> = {}): LocalStatePaths {
  const root = overrides.root ?? join(homedir(), ".grovie");

  return {
    root,
    reposDir: overrides.reposDir ?? join(root, "repos"),
    worktreesDir: overrides.worktreesDir ?? join(root, "worktrees"),
    runsDir: overrides.runsDir ?? join(root, "runs"),
    agentsDir: overrides.agentsDir ?? join(root, "agents"),
    locksDir: overrides.locksDir ?? join(root, "locks"),
    sessionsDir: overrides.sessionsDir ?? join(root, "sessions"),
  };
}

export function buildRunId(repository: string, issueNumber: number, attemptId = buildAttemptId()): string {
  return `${sanitizeRepository(repository)}-issue-${issueNumber}-${sanitizePathPart(attemptId)}`;
}

export function buildBranchName(branchPrefix: string, issueNumber: number): string {
  const normalizedPrefix = branchPrefix.endsWith("/") ? branchPrefix : `${branchPrefix}/`;
  return `${normalizedPrefix}issue-${issueNumber}`;
}

export function buildLocalBranchName(branchPrefix: string, issueNumber: number, attemptId: string): string {
  return `${buildBranchName(branchPrefix, issueNumber)}-${sanitizePathPart(attemptId)}`;
}

export function buildAttemptId(now = new Date(), uniqueId = randomUUID()): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${uniqueId.slice(0, 8)}`;
}

function sanitizeRepository(repository: string): string {
  return repository.replace(/[^A-Za-z0-9._-]/g, "-");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
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
