import type { GrovieConfig, RepositoryFileResult, StateRepoConfig } from "../config.js";
import type { CreatedComment, GitHubGateway, GitHubIssue, IssueReference } from "../github.js";
import type { DaemonLock, ExecutionLock, HandledCursor, LocalStatePaths, LockResult, PreparedRun, ResumableRun, RunCancellation, RunRequest } from "../local-state.js";
import type { IssueActivity } from "../queue.js";
import type { HandleRunResultResult, ResultHandler } from "../result.js";
import type { AgentRuntime, RuntimeMonitor, RuntimeName } from "../runtime.js";
import type { SessionStatus } from "../task.js";

export type RunIssueInput = {
  issueReference: IssueReference;
  repository: string;
  config: GrovieConfig;
  configPath: string;
  agent: RuntimeName;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  localState?: RunLocalState;
  resultHandler?: ResultHandler;
  stateRepo?: StateRepoConfig;
  agentId?: string;
  agentInstructions?: string;
  agentEnvKeys?: string[];
  runRequest?: {
    sourceRunId?: string;
    reason?: RunRequest["reason"];
  };
  triggerContext?: RunTriggerContext;
};

export type RunTriggerContext = {
  source: "daemon" | "manual" | "run-request";
  activity: IssueActivity;
  previousHandledCursor?: HandledCursor;
};

export type RunIssueResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  canceled?: boolean;
  handledThrough?: string;
};

export type RunIssueAsyncInput = RunIssueInput & {
  monitor?: RuntimeMonitor;
};

export type RunLocalState = {
  getPaths(): LocalStatePaths;
  readRepositoryFile?(input: { repository: string; path: string }): RepositoryFileResult;
  acquireDaemonLock?(machineId: string, now?: Date): LockResult<DaemonLock>;
  releaseDaemonLock?(lock: DaemonLock): void;
  isDaemonRunning?(machineId: string): boolean;
  acquireExecutionLock?(input: { repository: string; issueNumber: number; agentId: string; now?: Date }): LockResult<ExecutionLock>;
  hasExecutionLock?(input: { repository: string; issueNumber: number; agentId: string }): boolean;
  releaseExecutionLock?(lock: ExecutionLock): void;
  enqueueRunRequest?(input: { repository: string; issueNumber: number; agentId: string; now?: Date; sourceRunId?: string; reason?: RunRequest["reason"] }): RunRequest;
  takeRunRequest?(repository: string): RunRequest | undefined;
  interruptActiveRuns?(input: { now?: Date; reason: string }): ResumableRun[];
  takeResumableRun?(input: { repository: string; now?: Date }): ResumableRun | undefined;
  markSessionResuming?(input: { sourceRunId: string; now?: Date; reason: string }): void;
  markRunRejected?(input: { runId: string; now?: Date; reason: string }): void;
  requestRunCancellation?(input: { runId: string; reason?: string; now?: Date }): RunCancellation;
  isRunCancellationRequested?(runId: string): boolean;
  readHandledCursor?(input: { repository: string; issueNumber: number; agentId: string }): HandledCursor | undefined;
  writeHandledCursor?(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    handledThrough: string;
    issueFingerprint?: string;
    now?: Date;
  }): HandledCursor;
  prepareRun(input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    defaultBranch: string;
    branchPrefix: string;
    now?: Date;
    prompt: string;
    task: Record<string, unknown>;
    runRequest?: RunIssueInput["runRequest"];
  }): PreparedRun;
  appendEvent(run: PreparedRun, type: string, data?: Record<string, unknown>): void;
};

export type RunSummary = {
  status: SessionStatus;
  issue: GitHubIssue;
  runId: string;
  branchName: string;
  runDir: string;
  runtime: RuntimeName;
  agentId: string;
  machineId: string;
  result?: HandleRunResultResult;
  comment?: CreatedComment;
  error?: string;
  errorSource?: "prepare" | "runtime" | "result";
  startedAt?: string;
  endedAt?: string;
  stateRepo?: RunStateRepoSummary;
};

export type RunLifecycleComment = {
  id: number;
  url: string;
};

export type RunStateRepoSummary = {
  status: "synced" | "pending";
  target: string;
};

export type PreparedIssueRun =
  | {
    ok: true;
    issue: GitHubIssue;
    run: PreparedRun;
    localState: RunLocalState;
    runtime: AgentRuntime;
    lifecycleComment?: RunLifecycleComment;
  }
  | {
    ok: false;
    result: RunIssueResult;
  };
