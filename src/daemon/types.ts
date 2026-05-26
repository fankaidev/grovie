import type { AdminConsoleResolvedConfig } from "../admin-console.js";
import type { GrovieConfig, StateRepoConfig } from "../config.js";
import type { GitHubGateway } from "../github.js";
import type { AgentMetadata } from "../identity.js";
import type { RunIssueAsyncInput, RunIssueResult, RunLocalState } from "../run.js";
import type { AgentRuntime } from "../runtime.js";
import type { DaemonLifecycle } from "../daemon-lifecycle.js";

export type DaemonInput = {
  repository: string;
  label: string;
  config: GrovieConfig;
  configPath: string;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  localState?: RunLocalState;
  stateRepo?: StateRepoConfig;
  localAgents?: AgentMetadata[];
  once: boolean;
  workerId?: string;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => void | Promise<void>;
  onCycleResult?: (result: RunIssueResult) => void | Promise<void>;
  issueRunner?: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
  adminConsole?: AdminConsoleResolvedConfig;
  daemonLifecycle?: DaemonLifecycle;
  issueNumbers?: number[];
};

export type DaemonRepositoryInput = {
  repository: string;
  label?: string;
  config?: GrovieConfig;
  configPath?: string;
};

export type MultiRepositoryDaemonInput = Omit<DaemonInput, "repository" | "label"> & {
  repositories: DaemonRepositoryInput[];
};

export type DaemonCycleResult = RunIssueResult & {
  processed: boolean;
};

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const NO_LOCAL_AGENTS_MESSAGE = "No local agents are configured. Add agents to the global Grovie config before starting the daemon.";
