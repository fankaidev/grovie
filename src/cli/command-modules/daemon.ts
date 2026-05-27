import { getConfiguredAgentHealth, getRuntimeHealth } from "../../agent-health.js";
import { buildAgentLabel } from "../../assignment.js";
import { createAdminConsoleServer, resolveAdminConsoleConfig, startAdminConsoleServer } from "../../admin-console.js";
import {
  addWatchedRepository,
  loadGlobalConfig,
  removeWatchedRepository,
  resolveConfiguredAgents,
  saveGlobalConfig,
} from "../../config.js";
import { cleanupLocalState, parseOlderThan, renderCleanupResult } from "../../cleanup.js";
import { NO_LOCAL_AGENTS_MESSAGE } from "../../daemon.js";
import { followDaemonLogs, parseDaemonLogStream, readDaemonLogs } from "../../daemon-logs.js";
import { renderDaemonLifecycleStatus } from "../../daemon-lifecycle.js";
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

export const daemonCommand = {
    name: "daemon",
    description: "Run and control the local Grovie daemon.",
    usage: [
      "grovie daemon start",
      "grovie daemon stop [--force]",
      "grovie daemon status",
      "grovie daemon logs [--stream combined|stdout|stderr] [--lines 100] [--follow]",
    ].join("\n"),
    issue: "#77",
    run: (args: string[], context: CliContext) => {
      const [subcommand] = args;

      if (subcommand === "start") {
        const argValidation = validateCliArgs(args.slice(1), {
          valueOptions: ["--repo", "--label"],
          flags: ["--once"],
        });

        if (!argValidation.ok) {
          return argValidation.result;
        }

        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const localAgents = resolveConfiguredAgents(globalConfig.config, resolveLocalIdentity().machineId);

        if (localAgents.length === 0) {
          return {
            exitCode: 1,
            stderr: NO_LOCAL_AGENTS_MESSAGE,
          };
        }

        const adminConsole = resolveAdminConsoleConfig(globalConfig.config);

        if (adminConsole.enabled) {
          return context.adminConsolePortCheck(adminConsole)
            .then(() => startDaemonProcess(args, context))
            .catch(errorResult);
        }

        return startDaemonProcess(args, context);
      }

      if (subcommand === "stop") {
        const argValidation = validateCliArgs(args.slice(1), {
          flags: ["--force"],
        });

        if (!argValidation.ok) {
          return argValidation.result;
        }

        const result = context.daemonLifecycle.stop({
          root: context.localState.getPaths().root,
          force: args.includes("--force"),
        });

        return result.ok
          ? {
            exitCode: 0,
            stdout: [
              "grovie daemon stop",
              "",
              result.message,
            ].join("\n"),
          }
          : {
            exitCode: 1,
            stderr: result.message,
          };
      }

      if (subcommand === "status") {
        const argValidation = validateCliArgs(args.slice(1));

        if (!argValidation.ok) {
          return argValidation.result;
        }

        return {
          exitCode: 0,
          stdout: renderDaemonLifecycleStatus(context.daemonLifecycle.status({
            root: context.localState.getPaths().root,
          })),
        };
      }

      if (subcommand === "logs") {
        try {
          const logArgs = args.slice(1);
          const argValidation = validateCliArgs(logArgs, {
            valueOptions: ["--stream", "--lines"],
            flags: ["--follow"],
          });

          if (!argValidation.ok) {
            return argValidation.result;
          }

          const streamOption = readStringOption(logArgs, "--stream");

          if (!streamOption.ok) {
            return streamOption.result;
          }

          const linesOption = readNumberOption(logArgs, "--lines");

          if (!linesOption.ok) {
            return linesOption.result;
          }

          const input = {
            root: context.localState.getPaths().root,
            stream: parseDaemonLogStream(streamOption.value),
            lines: linesOption.value,
          };

          if (logArgs.includes("--follow")) {
            const result = followDaemonLogs(input);

            return result.ok
              ? {
                exitCode: result.exitCode,
              }
              : {
                exitCode: 1,
                stderr: result.message,
              };
          }

          const result = readDaemonLogs(input);

          return result.ok
            ? {
              exitCode: 0,
              stdout: result.output,
            }
            : {
              exitCode: 1,
              stderr: result.message,
            };
        } catch (error) {
          return errorResult(error);
        }
      }

      if (subcommand === undefined) {
        return {
          exitCode: 1,
          stderr: "Missing daemon subcommand. Usage: grovie daemon <start|stop|status|logs>",
        };
      }

      if (subcommand.startsWith("-")) {
        const argValidation = validateCliArgs(args);

        return argValidation.ok
          ? {
            exitCode: 1,
            stderr: "Missing daemon subcommand. Usage: grovie daemon <start|stop|status|logs>",
          }
          : argValidation.result;
      }

      return {
        exitCode: 1,
        stderr: `Unknown daemon subcommand: ${subcommand}. Usage: grovie daemon <start|stop|status|logs>`,
      };
    },
  } satisfies CliCommand;
