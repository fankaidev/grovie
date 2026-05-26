import { getConfiguredAgentHealth, getRuntimeHealth } from "../../agent-health.js";
import { buildAgentLabel } from "../../assignment.js";
import { createAdminConsoleServer, resolveAdminConsoleConfig, startAdminConsoleServer } from "../../admin-console.js";
import {
  addWatchedRepository,
  defaultConfig,
  loadGlobalConfig,
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
  renderGlobalConfigSource,
  renderRuntimeHealth,
  renderUnavailableAgents,
  resolveManualRunAgent,
  resolveQueueTrustedAuthors,
  startDaemonProcess,
} from "../command-support.js";
import type { CliCommand, CliContext } from "../types.js";

export const doctorCommand = {
    name: "doctor",
    description: "Check global Grovie config and local prerequisites.",
    usage: "grovie doctor",
    issue: "#3",
    run: (_args: string[], context: CliContext) => {
      try {
        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const authenticatedUser = context.github.getAuthenticatedUser();
        const identity = resolveLocalIdentity();

        if (!authenticatedUser.ok) {
          return githubErrorResult(authenticatedUser.error);
        }

        const runtimeHealth = getRuntimeHealth((runtimeName) => checkRuntimeAvailability(context, runtimeName));
        const agentHealth = getConfiguredAgentHealth(
          globalConfig.config,
          identity.machineId,
          (runtimeName) => checkRuntimeAvailability(context, runtimeName),
        );
        const doctorOutput = [
          "grovie doctor",
          "",
          `Global config: ${renderGlobalConfigSource(globalConfig.path, globalConfig.config.watchedRepositories.length)}`,
          `Machine id: ${identity.machineId}`,
          ...renderRuntimeHealth(runtimeHealth),
          ...renderConfiguredAgents(agentHealth),
          `GitHub: authenticated as ${authenticatedUser.value.login}.`,
        ];

        const unavailableAgents = agentHealth.filter((agent) => !agent.availability.available);

        if (unavailableAgents.length > 0) {
          return {
            exitCode: 1,
            stdout: doctorOutput.join("\n"),
            stderr: renderUnavailableAgents(unavailableAgents),
          };
        }

        return {
          exitCode: 0,
          stdout: doctorOutput.join("\n"),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
