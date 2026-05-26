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

export const stateCommand = {
    name: "state",
    description: "Configure optional private state repository sync.",
    usage: "grovie state init [--owner owner|--repo owner/grovie-state] [--branch main] [--sync-interval 60]",
    issue: "#57",
    run: (args: string[], context: CliContext) => {
      const [subcommand] = args;

      if (subcommand !== "init") {
        return {
          exitCode: 1,
          stderr: "Missing state subcommand. Usage: grovie state init [--owner owner|--repo owner/grovie-state]",
        };
      }

      const argValidation = validateCliArgs(args.slice(1), {
        valueOptions: ["--owner", "--repo", "--branch", "--sync-interval"],
      });

      if (!argValidation.ok) {
        return argValidation.result;
      }

      const ownerOption = readStringOption(args, "--owner");
      const repoOption = readStringOption(args, "--repo");
      const branchOption = readStringOption(args, "--branch");
      const intervalOption = readNumberOption(args, "--sync-interval");

      if (!ownerOption.ok) {
        return ownerOption.result;
      }

      if (!repoOption.ok) {
        return repoOption.result;
      }

      if (!branchOption.ok) {
        return branchOption.result;
      }

      if (!intervalOption.ok) {
        return intervalOption.result;
      }

      try {
        const root = context.localState.getPaths().root;
        const initialized = initStateRepository({
          root,
          github: context.github,
          owner: ownerOption.value,
          repository: repoOption.value,
          branch: branchOption.value,
          syncIntervalSeconds: intervalOption.value,
        });
        const loaded = loadGlobalConfig(root);
        const config = {
          ...loaded.config,
          stateRepo: {
            enabled: true,
            repository: initialized.repository,
            branch: initialized.branch,
            syncIntervalSeconds: initialized.syncIntervalSeconds,
          },
        };
        const path = saveGlobalConfig(root, config);

        return {
          exitCode: 0,
          stdout: [
            "grovie state init",
            "",
            initialized.created ? `Created private state repository ${initialized.repository}.` : `Configured state repository ${initialized.repository}.`,
            `Branch: ${initialized.branch}`,
            `Local path: ${initialized.localPath}`,
            `Sync interval: ${initialized.syncIntervalSeconds}s`,
            `Config: ${path}`,
            "State repo sync is optional; local execution does not depend on it.",
          ].join("\n"),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
