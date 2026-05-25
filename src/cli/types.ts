import type { RuntimeAvailabilityChecker } from "../agent-health.js";
import type { AdminConsoleResolvedConfig } from "../admin-console.js";
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

export type CliContext = {
  cwd: string;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  runtimeAvailabilityChecker?: RuntimeAvailabilityChecker;
  localState: RunLocalState;
  daemonLifecycle: DaemonLifecycle;
  adminConsolePortCheck: AdminConsolePortCheck;
};

export type CliCommand = {
  name: string;
  description: string;
  usage: string;
  issue: string;
  run: (args: string[], context: CliContext) => CliResult | Promise<CliResult>;
};
