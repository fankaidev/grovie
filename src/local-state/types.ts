import type { CommandRunner } from "../github.js";

export type LocalStatePaths = {
  root: string;
  reposDir: string;
  worktreesDir: string;
  runsDir: string;
  locksDir: string;
  sessionsDir: string;
};

export type RunRequestMetadata = {
  sourceRunId?: string;
  reason?: "resume";
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
  runRequest?: RunRequestMetadata;
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

export type RunMetadata = {
  status?: string;
  runId?: string;
  repository?: string;
  issueNumber?: number;
  agentId?: string;
  worktreePath?: string;
  resumeEligible?: boolean;
  runtimePid?: number;
};
