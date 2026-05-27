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
import { findLocalRun, listLocalRuns, renderLocalStatusOverview, renderRunDetail, renderRunsList } from "../../status.js";
import { initStateRepository } from "../../state-repo.js";
import {
  checkRuntimeAvailability,
  errorResult,
  githubErrorResult,
  readNumberOption,
  readStringOption,
  renderConfiguredAgents,
  renderGlobalConfigSource,
  renderRuntimeHealth,
  renderUnavailableAgents,
  resolveQueueTrustedAuthors,
  startDaemonProcess,
  validateCliArgs,
} from "../command-support.js";
import type { CliCommand, CliContext } from "../types.js";

export const statusCommand = {
    name: "status",
    description: "Show running and recent local Grovie runs.",
    usage: "grovie status",
    issue: "#36",
    run: (args: string[], context: CliContext) => {
      const argValidation = validateCliArgs(args);

      if (!argValidation.ok) {
        return argValidation.result;
      }

      try {
        const runs = listLocalRuns(context.localState.getPaths().runsDir);
        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const identity = resolveLocalIdentity();

        return {
          exitCode: 0,
          stdout: renderLocalStatusOverview({
            runs,
            daemonStatus: context.daemonLifecycle.status({
              root: context.localState.getPaths().root,
            }),
            adminConsole: resolveAdminConsoleConfig(globalConfig.config),
            agentHealth: getConfiguredAgentHealth(
              globalConfig.config,
              identity.machineId,
              (runtimeName) => checkRuntimeAvailability(context, runtimeName),
            ),
            watchedRepositories: globalConfig.config.watchedRepositories,
            paths: context.localState.getPaths(),
          }),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
