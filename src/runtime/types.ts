import type { GitHubIssue } from "../github.js";
import type { PreparedRun } from "../local-state.js";

export type RuntimeAvailability = {
  runtime: RuntimeName;
  command: string;
  available: boolean;
  version?: string;
  message: string;
};

export type RuntimeName = "codex" | "claude-code" | "pi";
export const SUPPORTED_RUNTIMES = ["codex", "claude-code", "pi"] as const satisfies RuntimeName[];

export type AgentRuntime = {
  name: RuntimeName;
  checkAvailability(): RuntimeAvailability;
  start(input: RuntimeStartInput): Promise<RuntimeRunResult> | RuntimeRunResult;
  resume(input: RuntimeResumeInput): Promise<RuntimeRunResult> | RuntimeRunResult;
  interrupt?(input: RuntimeInterruptInput): Promise<void> | void;
  run(input: AgentRunInput): RuntimeRunResult;
  runAsync?(input: AgentRunInput): Promise<RuntimeRunResult>;
};

export type AgentRunInput = {
  run: PreparedRun;
  issue: GitHubIssue;
  model?: string;
  envKeys?: string[];
  monitor?: RuntimeMonitor;
};

export type RuntimeStartInput = AgentRunInput;
export type RuntimeResumeInput = AgentRunInput & {
  runtimeSessionRef?: RuntimeSessionRef;
};
export type RuntimeInterruptInput = {
  run: PreparedRun;
  runtimeSessionRef?: RuntimeSessionRef;
};

export type RuntimeMonitor = {
  heartbeatIntervalMs?: number;
  onHeartbeat?(event: RuntimeMonitorEvent): void | Promise<void>;
  shouldCancel?(event: RuntimeMonitorEvent): boolean | Promise<boolean>;
};

export type RuntimeMonitorEvent = {
  run: PreparedRun;
  issue: GitHubIssue;
  command: string[];
  startedAt: string;
};

export type RuntimeExecution = {
  runtime: RuntimeName;
  command: string[];
  runtimeSessionRef?: RuntimeSessionRef;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  promptPath: string;
  taskPath: string;
  worktreePromptPath: string;
  worktreeTaskPath: string;
  stdoutPath: string;
  stderrPath: string;
  signal?: string;
  canceled?: boolean;
};

export type RuntimeSessionRef = {
  runtime: RuntimeName;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeRunResult =
  | {
    ok: true;
    execution: RuntimeExecution;
  }
  | {
    ok: false;
    execution: RuntimeExecution;
    canceled?: boolean;
    error: {
        message: string;
      };
  };

export type PreparedRuntimeInput = {
  runtime: RuntimeName;
  prompt: string;
  command: string[];
  env: NodeJS.ProcessEnv;
  worktreeTaskPath: string;
  worktreePromptPath: string;
  runtimeSessionRef?: RuntimeSessionRef;
  startedAt: string;
};

export type RuntimeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
  canceled?: boolean;
  streamed?: boolean;
};

export type RuntimeAdapter = {
  runtime: RuntimeName;
  command: string;
  availabilityArgs: string[];
  startCommand(input: AgentRunInput): string[];
  resumeCommand(sessionId: string, input: AgentRunInput): string[];
};

export type RuntimeRunOptions = {
  mode?: "auto" | "start" | "resume";
  runtimeSessionRef?: RuntimeSessionRef;
};
