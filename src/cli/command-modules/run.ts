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

export const runCommand = {
    name: "run",
    description: "Request one daemon-owned agent run for a GitHub issue.",
    usage: "grovie run owner/repo#123 [--agent coder@machine]",
    issue: "#7",
    run: (args: string[], context: CliContext) => {
      const issueRef = args.find((arg) => parseIssueReference(arg).ok);

      if (issueRef === undefined) {
        return {
          exitCode: 1,
          stderr: "Missing issue reference. Usage: grovie run owner/repo#123 [--agent coder@machine]",
        };
      }

      const parsedIssueReference = parseIssueReference(issueRef);

      if (!parsedIssueReference.ok) {
        return githubErrorResult(parsedIssueReference.error);
      }

      const agentOption = readStringOption(args, "--agent");

      if (!agentOption.ok) {
        return agentOption.result;
      }

      try {
        const targetRepository = formatIssueRepository(parsedIssueReference.value);
        const identity = resolveLocalIdentity();

        if (context.localState.isDaemonRunning?.(identity.machineId) !== true) {
          return {
            exitCode: 1,
            stderr: `No Grovie daemon is running for machine ${identity.machineId}. Start one with \`grovie daemon\`.`,
          };
        }

        const agentResult = resolveManualRunAgent({
          explicitAgentId: agentOption.value,
          issueReference: parsedIssueReference.value,
          github: context.github,
          machineId: identity.machineId,
        });

        if (!agentResult.ok) {
          return {
            exitCode: 1,
            stderr: agentResult.message,
          };
        }

        if (context.localState.hasExecutionLock?.({
          repository: targetRepository,
          issueNumber: parsedIssueReference.value.number,
          agentId: agentResult.agentId,
        }) === true) {
          return {
            exitCode: 1,
            stderr: `Grovie execution is already active for ${formatIssueReference(parsedIssueReference.value)} and ${agentResult.agentId}.`,
          };
        }

        const request = context.localState.enqueueRunRequest?.({
          repository: targetRepository,
          issueNumber: parsedIssueReference.value.number,
          agentId: agentResult.agentId,
          reason: "manual",
        });

        if (request === undefined) {
          return {
            exitCode: 1,
            stderr: "Local state does not support daemon run requests.",
          };
        }

        return {
          exitCode: 0,
          stdout: [
            "grovie run",
            "",
            `Requested daemon execution for ${formatIssueReference(parsedIssueReference.value)}.`,
            `Agent: ${agentResult.agentId}`,
            `Request: ${request.path}`,
          ].join("\n"),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
