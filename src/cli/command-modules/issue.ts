import { getConfiguredAgentHealth, getRuntimeHealth } from "../../agent-health.js";
import { buildAgentLabel } from "../../assignment.js";
import { createAdminConsoleServer, resolveAdminConsoleConfig, startAdminConsoleServer } from "../../admin-console.js";
import {
  addWatchedRepository,
  createConfigFile,
  defaultConfig,
  loadConfig,
  loadGlobalConfig,
  loadRepositoryConfig,
  removeWatchedRepository,
  resolveConfiguredAgents,
  saveGlobalConfig,
} from "../../config.js";
import { cleanupLocalState, parseOlderThan, renderCleanupResult } from "../../cleanup.js";
import { NO_LOCAL_AGENTS_MESSAGE, runDaemon, runDaemonForRepositories } from "../../daemon.js";
import { followDaemonLogs, parseDaemonLogStream, readDaemonLogs } from "../../daemon-logs.js";
import { renderDaemonLifecycleStatus } from "../../daemon-lifecycle.js";
import { getDaemonServicePath, installDaemonService, parseDaemonServicePlatform, renderDaemonServiceResult, uninstallDaemonService } from "../../daemon-service.js";
import { formatIssueReference, parseIssueReference } from "../../github.js";
import { resolveLocalIdentity } from "../../identity.js";
import { inspectQueue, renderQueueInspection } from "../../queue.js";
import { findLocalRun, listLocalRuns, renderLocalStatusOverview, renderRunDetail, renderRunsList } from "../../status.js";
import { initStateRepository } from "../../state-repo.js";
import {
  checkRuntimeAvailability,
  enqueueDaemonRunRequest,
  errorResult,
  formatIssueRepository,
  githubErrorResult,
  readNumberOption,
  readStringOption,
  renderConfiguredAgents,
  renderConfigPath,
  renderConfigSource,
  renderGlobalConfigSource,
  renderRuntimeHealth,
  renderUnavailableAgents,
  resolveManualRunAgent,
  resolveQueueTrustedAuthors,
  startDaemonProcess,
} from "../command-support.js";
import type { CliCommand, CliContext } from "../types.js";

export const issueCommand = {
    name: "issue",
    description: "Assign or unassign GitHub issues to local agents.",
    usage: "grovie issue <assign|unassign> owner/repo#123 agent@machine",
    issue: "#50",
    run: (args: string[], context: CliContext) => {
      const [subcommand, issueRef, agentId] = args;

      if (subcommand !== "assign" && subcommand !== "unassign") {
        return {
          exitCode: 1,
          stderr: "Missing issue subcommand. Usage: grovie issue <assign|unassign> owner/repo#123 agent@machine",
        };
      }

      if (issueRef === undefined || agentId === undefined) {
        return {
          exitCode: 1,
          stderr: `Missing issue reference or agent id. Usage: grovie issue ${subcommand} owner/repo#123 agent@machine`,
        };
      }

      const parsedIssueReference = parseIssueReference(issueRef);

      if (!parsedIssueReference.ok) {
        return githubErrorResult(parsedIssueReference.error);
      }

      let label: string;

      try {
        label = buildAgentLabel(agentId);
      } catch (error) {
        return errorResult(error);
      }

      const result = subcommand === "assign"
        ? context.github.addLabels(parsedIssueReference.value, [label])
        : context.github.removeLabel(parsedIssueReference.value, label);

      if (!result.ok) {
        return githubErrorResult(result.error);
      }

      return {
        exitCode: 0,
        stdout: [
          `grovie issue ${subcommand}`,
          "",
          `${subcommand === "assign" ? "Added" : "Removed"} ${label} ${subcommand === "assign" ? "to" : "from"} ${formatIssueReference(parsedIssueReference.value)}.`,
        ].join("\n"),
      };
    },
  } satisfies CliCommand;
