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

export const runsCommand = {
    name: "runs",
    description: "Inspect local Grovie run history and logs.",
    usage: "grovie runs <list|show|retry|rerun|cleanup> [run-id|owner/repo#123]",
    issue: "#36",
    run: (args: string[], context: CliContext) => {
      const [subcommand, runId] = args;
      const runsDir = context.localState.getPaths().runsDir;

      try {
        if (subcommand === "list") {
          return {
            exitCode: 0,
            stdout: renderRunsList(listLocalRuns(runsDir)),
          };
        }

        if (subcommand === "show") {
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

        if (subcommand === "retry") {
          if (runId === undefined) {
            return {
              exitCode: 1,
              stderr: "Missing run id. Usage: grovie runs retry <run-id>",
            };
          }

          const run = findLocalRun(runsDir, runId);

          if (run === undefined) {
            return {
              exitCode: 1,
              stderr: `Run not found: ${runId}`,
            };
          }

          if (run.status !== "failed" && run.status !== "canceled" && run.status !== "stale") {
            return {
              exitCode: 1,
              stderr: `Run ${runId} is ${run.status}; only failed, canceled, or stale runs can be retried.`,
            };
          }

          if (run.repository === undefined || run.issueNumber === undefined || run.agentId === undefined) {
            return {
              exitCode: 1,
              stderr: `Run ${runId} is missing repository, issue number, or agent metadata.`,
            };
          }

          return enqueueDaemonRunRequest({
            context,
            repository: run.repository,
            issueNumber: run.issueNumber,
            agentId: run.agentId,
            sourceRunId: run.runId,
            reason: "retry",
            title: "grovie runs retry",
            action: `Retry requested for ${run.runId}.`,
            mode: "The daemon will create a new run in the existing issue-agent session and reuse the session worktree.",
          });
        }

        if (subcommand === "rerun") {
          if (runId === undefined) {
            return {
              exitCode: 1,
              stderr: "Missing issue reference. Usage: grovie runs rerun owner/repo#123 --agent coder@machine",
            };
          }

          const parsedIssueReference = parseIssueReference(runId);

          if (!parsedIssueReference.ok) {
            return githubErrorResult(parsedIssueReference.error);
          }

          const agentOption = readStringOption(args, "--agent");

          if (!agentOption.ok) {
            return agentOption.result;
          }

          if (agentOption.value === undefined) {
            return {
              exitCode: 1,
              stderr: "Missing agent. Usage: grovie runs rerun owner/repo#123 --agent coder@machine",
            };
          }

          return enqueueDaemonRunRequest({
            context,
            repository: formatIssueRepository(parsedIssueReference.value),
            issueNumber: parsedIssueReference.value.number,
            agentId: agentOption.value,
            reason: "rerun",
            title: "grovie runs rerun",
            action: `Rerun requested for ${formatIssueReference(parsedIssueReference.value)}.`,
            mode: "The daemon will create a new run in the existing issue-agent session and reuse the session worktree.",
          });
        }

        if (subcommand === "cleanup") {
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
          stderr: "Missing runs subcommand. Usage: grovie runs <list|show|retry|rerun|cleanup> [run-id|owner/repo#123]",
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;
