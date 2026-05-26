import type { Server } from "node:http";
import type { AgentVerifier, RuntimeAvailabilityChecker } from "../agent-health.js";
import type { AdminConsoleResolvedConfig, StartedAdminConsole } from "../admin-console.js";
import type { DaemonLifecycle } from "../daemon-lifecycle.js";
import type { GitHubGateway } from "../github.js";
import type { RunLocalState } from "../run.js";
import type { AgentRuntime } from "../runtime.js";

export type CliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type AdminConsolePortCheck = (config: AdminConsoleResolvedConfig) => Promise<void>;
export type AdminConsoleStarter = (input: {
  config: AdminConsoleResolvedConfig;
  server?: Server;
}) => Promise<StartedAdminConsole>;

export type CliContext = {
  cwd: string;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  runtimeAvailabilityChecker?: RuntimeAvailabilityChecker;
  agentVerifier?: AgentVerifier;
  progressWriter?: (output: string) => void;
  localState: RunLocalState;
  daemonLifecycle: DaemonLifecycle;
  adminConsolePortCheck: AdminConsolePortCheck;
  adminConsoleStarter: AdminConsoleStarter;
};

export type CliCommand = {
  name: string;
  description: string;
  usage: string;
  issue: string;
  run: (args: string[], context: CliContext) => CliResult | Promise<CliResult>;
};
