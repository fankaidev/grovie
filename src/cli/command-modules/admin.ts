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

export const adminCommand = {
    name: "admin",
    description: "Run the opt-in local admin console.",
    usage: "grovie admin serve",
    issue: "#71",
    run: async (args: string[], context: CliContext) => {
      const [subcommand] = args;

      if (subcommand !== "serve") {
        return {
          exitCode: 1,
          stderr: "Missing admin subcommand. Usage: grovie admin serve",
        };
      }

      try {
        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const config = resolveAdminConsoleConfig(globalConfig.config);
        const started = await startAdminConsoleServer({
          config,
          server: createAdminConsoleServer({
            paths: context.localState.getPaths(),
            daemonLifecycle: context.daemonLifecycle,
            runtimeAvailabilityChecker: context.runtimeAvailabilityChecker,
          }),
        });

        return {
          exitCode: 0,
          stdout: [
            "grovie admin serve",
            "",
            `Admin console listening at ${started.url}.`,
          ].join("\n"),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
