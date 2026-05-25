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

export const queueCommand = {
    name: "queue",
    description: "List assigned issues and local daemon pick order.",
    usage: "grovie queue list [--repo owner/repo]",
    issue: "#40",
    run: (args: string[], context: CliContext) => {
      const [subcommand] = args;

      if (subcommand !== "list") {
        return {
          exitCode: 1,
          stderr: "Missing queue subcommand. Usage: grovie queue list [--repo owner/repo]",
        };
      }

      const repoOption = readStringOption(args, "--repo");

      if (!repoOption.ok) {
        return repoOption.result;
      }

      try {
        const config = defaultConfig();
        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const identity = resolveLocalIdentity();
        const localAgents = resolveConfiguredAgents(globalConfig.config, identity.machineId);
        const repositories = repoOption.value === undefined
          ? globalConfig.config.watchedRepositories.map((watchedRepository) => ({
            repository: watchedRepository.repository,
            label: watchedRepository.label ?? config.queue.label,
          }))
          : [
            {
              repository: repoOption.value,
              label: config.queue.label,
            },
          ];
        const queueRepositories = repositories.map((repository) => {
          const repositoryConfig = loadRepositoryConfig(repository.repository, context.localState);
          const trustedAuthors = resolveQueueTrustedAuthors(repositoryConfig.config, context.github);

          if (!trustedAuthors.ok) {
            throw new Error(trustedAuthors.message);
          }

          return {
            ...repository,
            trustedAuthors: trustedAuthors.value,
          };
        });
        const result = inspectQueue({
          repositories: queueRepositories,
          github: context.github,
          machineId: identity.machineId,
          configuredAgentIds: localAgents.map((agent) => agent.agentId),
          localState: context.localState,
        });

        if (!result.ok) {
          return {
            exitCode: 1,
            stderr: result.message,
          };
        }

        return {
          exitCode: 0,
          stdout: args.includes("--json") ? JSON.stringify(result.value, null, 2) : renderQueueInspection(result.value),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
