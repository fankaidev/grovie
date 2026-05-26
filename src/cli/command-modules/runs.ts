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

export const runsCommand = {
    name: "runs",
    description: "Inspect local Grovie run history and logs.",
    usage: [
      "grovie runs list",
      "grovie runs show <run-id>",
      "grovie runs cleanup [--dry-run] [--logs] [--older-than 30m|12h|7d]",
    ].join("\n"),
    issue: "#36",
    run: (args: string[], context: CliContext) => {
      const [subcommand, runId] = args;
      const runsDir = context.localState.getPaths().runsDir;

      try {
        if (subcommand === "list") {
          const argValidation = validateCliArgs(args.slice(1));

          if (!argValidation.ok) {
            return argValidation.result;
          }

          return {
            exitCode: 0,
            stdout: renderRunsList(listLocalRuns(runsDir)),
          };
        }

        if (subcommand === "show") {
          const argValidation = validateCliArgs(args.slice(1), {
            positionals: {
              min: 1,
              max: 1,
              label: "run id",
            },
          });

          if (!argValidation.ok) {
            return argValidation.result;
          }

          if (runId === undefined) {
            return {
              exitCode: 1,
              stderr: "Missing run id. Usage: grovie runs show <run-id>",
            };
          }

          const run = findLocalRun(runsDir, runId);

          if (run === undefined) {
            return {
              exitCode: 1,
              stderr: `Run not found: ${runId}`,
            };
          }

          return {
            exitCode: 0,
            stdout: renderRunDetail(run),
          };
        }

        if (subcommand === "cleanup") {
          const argValidation = validateCliArgs(args.slice(1), {
            valueOptions: ["--older-than"],
            flags: ["--dry-run", "--logs"],
          });

          if (!argValidation.ok) {
            return argValidation.result;
          }

          const olderThanOption = readStringOption(args, "--older-than");

          if (!olderThanOption.ok) {
            return olderThanOption.result;
          }

          const olderThanMs = olderThanOption.value === undefined ? undefined : parseOlderThan(olderThanOption.value);

          if (olderThanOption.value !== undefined && olderThanMs === undefined) {
            return {
              exitCode: 1,
              stderr: "Invalid --older-than value. Use a positive duration like 30m, 12h, or 7d.",
            };
          }

          const result = cleanupLocalState({
            paths: context.localState.getPaths(),
            dryRun: args.includes("--dry-run"),
            includeLogs: args.includes("--logs"),
            olderThanMs,
          });

          return {
            exitCode: 0,
            stdout: renderCleanupResult(result),
          };
        }

        return {
          exitCode: 1,
          stderr: "Missing runs subcommand. Usage: grovie runs <list|show|cleanup>",
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
