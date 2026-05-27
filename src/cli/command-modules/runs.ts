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
import { formatIssueReference, parseIssueReference } from "../../github.js";
import { resolveLocalIdentity } from "../../identity.js";
import { findLocalRun, listLocalRuns, renderLocalStatusOverview, renderRunDetail, renderRunsList, type LocalRunSummary } from "../../status.js";
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
import type { CliCommand, CliContext, CliResult } from "../types.js";

const DEFAULT_RUNS_LIST_LIMIT = 20;
const RUN_STATUSES = new Set<LocalRunSummary["status"]>([
  "preparing",
  "prepared",
  "running",
  "interrupting",
  "interrupted",
  "resuming",
  "rejected",
  "succeeded",
  "failed",
  "canceled",
  "stale",
  "unknown",
]);

export const runsCommand = {
    name: "runs",
    description: "Inspect local Grovie run history and logs.",
    usage: [
      "grovie runs list [--limit 20] [--status status] [--repo owner/repo] [--issue owner/repo#123|123] [--agent agent@machine]",
      "grovie runs show <run-id>",
      "grovie runs cleanup [--dry-run] [--logs] [--older-than 30m|12h|7d]",
    ].join("\n"),
    issue: "#36",
    run: (args: string[], context: CliContext) => {
      const [subcommand, runId] = args;
      const runsDir = context.localState.getPaths().runsDir;

      try {
        if (subcommand === "list") {
          const argValidation = validateCliArgs(args.slice(1), {
            valueOptions: ["--limit", "--status", "--repo", "--issue", "--agent"],
          });

          if (!argValidation.ok) {
            return argValidation.result;
          }

          const filters = parseRunsListFilters(args);

          if (!filters.ok) {
            return filters.result;
          }

          return {
            exitCode: 0,
            stdout: renderRunsList(applyRunsListFilters(listLocalRuns(runsDir), filters.value)),
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

type RunsListFilters = {
  limit: number;
  status?: LocalRunSummary["status"];
  repository?: string;
  issueNumber?: number;
  agentId?: string;
};

function parseRunsListFilters(args: string[]): { ok: true; value: RunsListFilters } | { ok: false; result: CliResult } {
  const limitOption = readNumberOption(args, "--limit");

  if (!limitOption.ok) {
    return limitOption;
  }

  const statusOption = readStringOption(args, "--status");

  if (!statusOption.ok) {
    return statusOption;
  }

  if (statusOption.value !== undefined && !RUN_STATUSES.has(statusOption.value as LocalRunSummary["status"])) {
    return invalidRunsListOption(`Invalid --status value. Use one of: ${[...RUN_STATUSES].join(", ")}.`);
  }

  const repoOption = readStringOption(args, "--repo");

  if (!repoOption.ok) {
    return repoOption;
  }

  const issueOption = readStringOption(args, "--issue");

  if (!issueOption.ok) {
    return issueOption;
  }

  const issueFilter = parseIssueFilter(issueOption.value);

  if (!issueFilter.ok) {
    return issueFilter;
  }

  if (repoOption.value !== undefined && issueFilter.value.repository !== undefined && repoOption.value !== issueFilter.value.repository) {
    return invalidRunsListOption("Conflicting --repo and --issue repository values.");
  }

  const agentOption = readStringOption(args, "--agent");

  if (!agentOption.ok) {
    return agentOption;
  }

  return {
    ok: true,
    value: {
      limit: limitOption.value ?? DEFAULT_RUNS_LIST_LIMIT,
      status: statusOption.value as LocalRunSummary["status"] | undefined,
      repository: issueFilter.value.repository ?? repoOption.value,
      issueNumber: issueFilter.value.issueNumber,
      agentId: agentOption.value,
    },
  };
}

function parseIssueFilter(value: string | undefined): { ok: true; value: { repository?: string; issueNumber?: number } } | { ok: false; result: CliResult } {
  if (value === undefined) {
    return {
      ok: true,
      value: {},
    };
  }

  if (/^[1-9][0-9]*$/.test(value)) {
    return {
      ok: true,
      value: {
        issueNumber: Number(value),
      },
    };
  }

  const parsed = parseIssueReference(value);

  if (!parsed.ok) {
    return invalidRunsListOption("Invalid --issue value. Use a positive issue number or owner/repo#123.");
  }

  return {
    ok: true,
    value: {
      repository: `${parsed.value.owner}/${parsed.value.repo}`,
      issueNumber: parsed.value.number,
    },
  };
}

function applyRunsListFilters(runs: LocalRunSummary[], filters: RunsListFilters): LocalRunSummary[] {
  return runs
    .filter((run) => filters.status === undefined || run.status === filters.status)
    .filter((run) => filters.repository === undefined || run.repository === filters.repository)
    .filter((run) => filters.issueNumber === undefined || run.issueNumber === filters.issueNumber)
    .filter((run) => filters.agentId === undefined || run.agentId === filters.agentId)
    .slice(0, filters.limit);
}

function invalidRunsListOption(message: string): { ok: false; result: CliResult } {
  return {
    ok: false,
    result: {
      exitCode: 1,
      stderr: message,
    },
  };
}
