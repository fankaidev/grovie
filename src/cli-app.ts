import { createServer } from "node:http";
import { getConfiguredAgentHealth, getRuntimeHealth, type AgentHealth, type RuntimeAvailabilityChecker } from "./agent-health.js";
import { buildAgentLabel, getAssignedAgentIds, parseAgentId } from "./assignment.js";
import { createAdminConsoleServer, resolveAdminConsoleConfig, startAdminConsoleServer, type AdminConsoleResolvedConfig } from "./admin-console.js";
import {
  addWatchedRepository,
  CONFIG_FILE_NAME,
  createConfigFile,
  defaultConfig,
  loadConfig,
  loadGlobalConfig,
  loadRepositoryConfig,
  removeWatchedRepository,
  resolveConfiguredAgents,
  saveGlobalConfig,
  type LoadedConfig,
} from "./config.js";
import { cleanupLocalState, parseOlderThan, renderCleanupResult } from "./cleanup.js";
import { NO_LOCAL_AGENTS_MESSAGE, runDaemon, runDaemonForRepositories } from "./daemon.js";
import { followDaemonLogs, parseDaemonLogStream, readDaemonLogs } from "./daemon-logs.js";
import { LocalDaemonLifecycle, renderDaemonLifecycleStatus, type DaemonLifecycle } from "./daemon-lifecycle.js";
import { getDaemonServicePath, installDaemonService, parseDaemonServicePlatform, renderDaemonServiceResult, uninstallDaemonService } from "./daemon-service.js";
import { formatIssueReference, GhGitHubGateway, type GitHubGateway, parseIssueReference } from "./github.js";
import { resolveLocalIdentity } from "./identity.js";
import { LocalState } from "./local-state.js";
import { inspectQueue, renderQueueInspection } from "./queue.js";
import type { RunLocalState } from "./run.js";
import { createRuntime, type AgentRuntime } from "./runtime.js";
import type { RuntimeAvailability, RuntimeName } from "./runtime.js";
import { findLocalRun, listLocalRuns, renderLocalStatusOverview, renderRunDetail, renderRunsList } from "./status.js";
import { initStateRepository } from "./state-repo.js";
import { GROVIE_VERSION } from "./version.js";

export type CliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type CliContext = {
  cwd: string;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  runtimeAvailabilityChecker?: RuntimeAvailabilityChecker;
  localState: RunLocalState;
  daemonLifecycle: DaemonLifecycle;
  adminConsolePortCheck: AdminConsolePortCheck;
};

export type AdminConsolePortCheck = (config: AdminConsoleResolvedConfig) => Promise<void>;

type CliCommand = {
  name: string;
  description: string;
  usage: string;
  issue: string;
  run: (args: string[], context: CliContext) => CliResult | Promise<CliResult>;
};

const commandDefinitions = [
  {
    name: "init",
    description: "Create the minimal Grovie project config.",
    usage: "grovie init",
    issue: "#3",
    run: (_args: string[], context: CliContext) => {
      try {
        createConfigFile(context.cwd);
      } catch (error) {
        return errorResult(error);
      }

      return {
        exitCode: 0,
        stdout: [
          "grovie init",
          "",
          "Created .grovie.yml.",
          "Run `grovie doctor` to validate it.",
        ].join("\n"),
      };
    },
  },
  {
    name: "doctor",
    description: "Check global worker config and local prerequisites.",
    usage: "grovie doctor",
    issue: "#3",
    run: (_args: string[], context: CliContext) => {
      try {
        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const loaded = loadConfig(context.cwd);
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
          `Local policy config: ${renderConfigSource(loaded)}`,
          `Machine id: ${identity.machineId}`,
          ...renderRuntimeHealth(runtimeHealth),
          ...renderConfiguredAgents(agentHealth),
          `Queue label: ${loaded.config.queue.label}`,
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
  },
  {
    name: "status",
    description: "Show running and recent local Grovie runs.",
    usage: "grovie status",
    issue: "#36",
    run: (_args: string[], context: CliContext) => {
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
  },
  {
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
  },
  {
    name: "issue",
    description: "Assign or unassign GitHub issues to local agents.",
    usage: "grovie issue <assign|unassign> owner/repo#123 agent@machine",
    issue: "#50",
    run: (args: string[], context: CliContext) => {
      const [subcommand, issueRef, agentId] = args;

      if (subcommand !== "assign" && subcommand !== "unassign") {
        return {
          exitCode: 1,
          stderr: "Missing issue subcommand. Usage: grovie issue <assign|unassign> owner/repo#123 agent@machine",
        };
      }

      if (issueRef === undefined || agentId === undefined) {
        return {
          exitCode: 1,
          stderr: `Missing issue reference or agent id. Usage: grovie issue ${subcommand} owner/repo#123 agent@machine`,
        };
      }

      const parsedIssueReference = parseIssueReference(issueRef);

      if (!parsedIssueReference.ok) {
        return githubErrorResult(parsedIssueReference.error);
      }

      let label: string;

      try {
        label = buildAgentLabel(agentId);
      } catch (error) {
        return errorResult(error);
      }

      const result = subcommand === "assign"
        ? context.github.addLabels(parsedIssueReference.value, [label])
        : context.github.removeLabel(parsedIssueReference.value, label);

      if (!result.ok) {
        return githubErrorResult(result.error);
      }

      return {
        exitCode: 0,
        stdout: [
          `grovie issue ${subcommand}`,
          "",
          `${subcommand === "assign" ? "Added" : "Removed"} ${label} ${subcommand === "assign" ? "to" : "from"} ${formatIssueReference(parsedIssueReference.value)}.`,
        ].join("\n"),
      };
    },
  },
  {
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
  },
  {
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
        const result = inspectQueue({
          repositories,
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
  },
  {
    name: "daemon",
    description: "Run and control the local Grovie daemon.",
    usage: "grovie daemon <run|start|stop|status|logs|service> [--repo owner/repo] [--label grovie] [--once]",
    issue: "#77",
    run: (args: string[], context: CliContext) => {
      const [subcommand] = args;

      if (subcommand === "start") {
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

      if (subcommand === "service") {
        const action = args[1];

        if (action !== "install" && action !== "uninstall" && action !== "path") {
          return {
            exitCode: 1,
            stderr: "Missing daemon service action. Usage: grovie daemon service <install|uninstall|path> [--platform launchd|systemd]",
          };
        }

        const platformOption = readStringOption(args.slice(2), "--platform");

        if (!platformOption.ok) {
          return platformOption.result;
        }

        const platform = parseDaemonServicePlatform(platformOption.value);

        if (platformOption.value !== undefined && platform === undefined) {
          return {
            exitCode: 1,
            stderr: "Invalid --platform value. Use launchd or systemd.",
          };
        }

        try {
          const input = {
            paths: context.localState.getPaths(),
            platform,
          };
          const result = action === "install"
            ? installDaemonService(input)
            : action === "uninstall"
              ? uninstallDaemonService(input)
              : getDaemonServicePath(input);

          return {
            exitCode: 0,
            stdout: renderDaemonServiceResult(action, result),
          };
        } catch (error) {
          return errorResult(error);
        }
      }

      const runArgs = subcommand === "run" ? args.slice(1) : args;

      try {
        const normalizedRepoOption = readStringOption(runArgs, "--repo");

        if (!normalizedRepoOption.ok) {
          return normalizedRepoOption.result;
        }

        const normalizedLabelOption = readStringOption(runArgs, "--label");

        if (!normalizedLabelOption.ok) {
          return normalizedLabelOption.result;
        }

        if (normalizedRepoOption.value !== undefined) {
          const loaded = loadRepositoryConfig(normalizedRepoOption.value, context.localState);
          const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
          const localAgents = resolveConfiguredAgents(globalConfig.config, resolveLocalIdentity().machineId);

          return runDaemon({
            repository: normalizedRepoOption.value,
            label: normalizedLabelOption.value ?? loaded.config.queue.label,
            config: loaded.config,
            configPath: renderConfigPath(loaded),
            github: context.github,
            runtime: context.runtime,
            localState: context.localState,
            stateRepo: globalConfig.config.stateRepo,
            localAgents,
            once: runArgs.includes("--once"),
            adminConsole: resolveAdminConsoleConfig(globalConfig.config),
            daemonLifecycle: context.daemonLifecycle,
          });
        }

        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const localAgents = resolveConfiguredAgents(globalConfig.config, resolveLocalIdentity().machineId);

        return runDaemonForRepositories({
          repositories: globalConfig.config.watchedRepositories.map((watchedRepository) => ({
            repository: watchedRepository.repository,
            label: normalizedLabelOption.value ?? watchedRepository.label,
          })),
          repositoryConfigLoader: (repository) => loadRepositoryConfig(repository, context.localState),
          config: defaultConfig(),
          configPath: "built-in defaults",
          github: context.github,
          runtime: context.runtime,
          localState: context.localState,
          stateRepo: globalConfig.config.stateRepo,
          localAgents,
          once: runArgs.includes("--once"),
          adminConsole: resolveAdminConsoleConfig(globalConfig.config),
          daemonLifecycle: context.daemonLifecycle,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  },
  {
    name: "state",
    description: "Configure optional private state repository sync.",
    usage: "grovie state init [--owner owner|--repo owner/grovie-state] [--branch main] [--path ~/.grovie/state-repo] [--sync-interval 60]",
    issue: "#57",
    run: (args: string[], context: CliContext) => {
      const [subcommand] = args;

      if (subcommand !== "init") {
        return {
          exitCode: 1,
          stderr: "Missing state subcommand. Usage: grovie state init [--owner owner|--repo owner/grovie-state]",
        };
      }

      const ownerOption = readStringOption(args, "--owner");
      const repoOption = readStringOption(args, "--repo");
      const branchOption = readStringOption(args, "--branch");
      const pathOption = readStringOption(args, "--path");
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

      if (!pathOption.ok) {
        return pathOption.result;
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
          localPath: pathOption.value,
          syncIntervalSeconds: intervalOption.value,
        });
        const loaded = loadGlobalConfig(root);
        const config = {
          ...loaded.config,
          stateRepo: {
            enabled: true,
            repository: initialized.repository,
            branch: initialized.branch,
            localPath: initialized.localPath,
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
  },
  {
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
  },
  {
    name: "watch",
    description: "Manage globally watched repositories for daemon polling.",
    usage: "grovie watch <add|list|remove> [owner/repo] [--label grovie]",
    issue: "#31",
    run: (args: string[], context: CliContext) => {
      const [subcommand, repository] = args;
      const globalRoot = context.localState.getPaths().root;

      try {
        if (subcommand === "list") {
          const loaded = loadGlobalConfig(globalRoot);
          const lines = loaded.config.watchedRepositories.map((watchedRepository) => {
            const label = watchedRepository.label === undefined ? "" : ` label=${watchedRepository.label}`;
            return `- ${watchedRepository.repository}${label}`;
          });

          return {
            exitCode: 0,
            stdout: [
              "grovie watch list",
              "",
              `Config: ${loaded.path}`,
              lines.length === 0 ? "No watched repositories configured." : lines.join("\n"),
            ].join("\n"),
          };
        }

        if (subcommand === "add") {
          if (repository === undefined) {
            return {
              exitCode: 1,
              stderr: "Missing repository. Usage: grovie watch add owner/repo [--label grovie]",
            };
          }

          const labelOption = readStringOption(args, "--label");

          if (!labelOption.ok) {
            return labelOption.result;
          }

          const loaded = loadGlobalConfig(globalRoot);
          const nextConfig = addWatchedRepository(loaded.config, {
            repository,
            label: labelOption.value,
          });
          const path = saveGlobalConfig(globalRoot, nextConfig);

          return {
            exitCode: 0,
            stdout: [
              "grovie watch add",
              "",
              `Added ${repository}.`,
              `Config: ${path}`,
            ].join("\n"),
          };
        }

        if (subcommand === "remove") {
          if (repository === undefined) {
            return {
              exitCode: 1,
              stderr: "Missing repository. Usage: grovie watch remove owner/repo",
            };
          }

          const loaded = loadGlobalConfig(globalRoot);
          const beforeCount = loaded.config.watchedRepositories.length;
          const nextConfig = removeWatchedRepository(loaded.config, repository);
          const path = saveGlobalConfig(globalRoot, nextConfig);
          const removed = nextConfig.watchedRepositories.length < beforeCount;

          return {
            exitCode: 0,
            stdout: [
              "grovie watch remove",
              "",
              removed ? `Removed ${repository}.` : `${repository} was not watched.`,
              `Config: ${path}`,
            ].join("\n"),
          };
        }

        return {
          exitCode: 1,
          stderr: "Missing watch subcommand. Usage: grovie watch <add|list|remove> [owner/repo]",
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  },
] satisfies CliCommand[];

export const commands: readonly CliCommand[] = commandDefinitions;

export function runCli(args: string[], context: Partial<CliContext> = {}): CliResult {
  const result = runCliInternal(args, context);

  if (isPromise(result)) {
    throw new Error("Command requires asynchronous execution. Use runCliAsync.");
  }

  return result;
}

export async function runCliAsync(args: string[], context: Partial<CliContext> = {}): Promise<CliResult> {
  return runCliInternal(args, context);
}

function runCliInternal(args: string[], context: Partial<CliContext> = {}): CliResult | Promise<CliResult> {
  const cliContext = {
    cwd: context.cwd ?? process.cwd(),
    github: context.github ?? new GhGitHubGateway(),
    runtime: context.runtime,
    runtimeAvailabilityChecker: context.runtimeAvailabilityChecker,
    localState: context.localState ?? new LocalState(),
    daemonLifecycle: context.daemonLifecycle ?? new LocalDaemonLifecycle(),
    adminConsolePortCheck: context.adminConsolePortCheck ?? checkAdminConsolePortAvailable,
  };
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [commandName, ...commandArgs] = normalizedArgs;

  if (commandName === undefined || commandName === "--help" || commandName === "-h" || commandName === "help") {
    return {
      exitCode: 0,
      stdout: renderHelp(),
    };
  }

  if (commandName === "--version" || commandName === "-v") {
    return {
      exitCode: 0,
      stdout: GROVIE_VERSION,
    };
  }

  const command = commands.find((candidate) => candidate.name === commandName);

  if (command === undefined) {
    return {
      exitCode: 1,
      stderr: `Unknown command: ${commandName}\n\n${renderHelp()}`,
    };
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    return {
      exitCode: 0,
      stdout: renderCommandHelp(command),
    };
  }

  return command.run(commandArgs, cliContext);
}

function checkRuntimeAvailability(context: CliContext, runtime: RuntimeName): RuntimeAvailability {
  if (context.runtimeAvailabilityChecker !== undefined) {
    return context.runtimeAvailabilityChecker(runtime);
  }

  if (context.runtime?.name === runtime) {
    return context.runtime.checkAvailability();
  }

  return createRuntime(runtime).checkAvailability();
}

function startDaemonProcess(args: string[], context: CliContext): CliResult {
  const result = context.daemonLifecycle.start({
    root: context.localState.getPaths().root,
    args,
  });

  if (!result.ok) {
    return {
      exitCode: 1,
      stderr: result.message,
    };
  }

  return {
    exitCode: 0,
    stdout: [
      "grovie daemon start",
      "",
      `Started Grovie daemon pid ${result.state.pid}.`,
      `State: ${result.state.statePath}`,
      `Stdout log: ${result.state.stdoutPath}`,
      `Stderr log: ${result.state.stderrPath}`,
    ].join("\n"),
  };
}

function checkAdminConsolePortAvailable(config: AdminConsoleResolvedConfig): Promise<void> {
  if (!config.enabled) {
    return Promise.resolve();
  }

  const server = createServer();

  return new Promise((resolve, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error(`Admin console port ${config.port} is unavailable on ${config.host}.`));
    };
    const onListening = () => {
      server.off("error", onError);
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

function renderRuntimeHealth(runtimes: RuntimeAvailability[]): string[] {
  return [
    "Runtimes:",
    ...runtimes.map((runtime) => `- ${runtime.runtime} command=${runtime.command}: ${runtime.message}`),
  ];
}

function renderConfiguredAgents(agents: AgentHealth[]): string[] {
  if (agents.length === 0) {
    return ["Configured agents: none"];
  }

  return [
    "Configured agents:",
    ...agents.map((agent) => `- ${agent.agentId} (${agent.runtime}, command=${agent.availability.command}): ${agent.availability.message}`),
  ];
}

function renderUnavailableAgents(unavailableAgents: AgentHealth[]): string {
  return [
    "Unavailable configured agents:",
    ...unavailableAgents.map((agent) => `- ${agent.agentId}: ${agent.availability.message}`),
  ].join("\n");
}

function isPromise(value: CliResult | Promise<CliResult>): value is Promise<CliResult> {
  return typeof (value as Promise<CliResult>).then === "function";
}

export function renderHelp(): string {
  const maxNameLength = Math.max(...commands.map((command) => command.name.length));
  const commandLines = commands
    .map((command) => `  ${command.name.padEnd(maxNameLength)}  ${command.description}`)
    .join("\n");

  return [
    "grovie",
    "",
    "Usage:",
    "  grovie <command> [options]",
    "",
    "Options:",
    "  -v, --version  Print the Grovie version.",
    "  -h, --help     Print help.",
    "",
    "Commands:",
    commandLines,
    "",
    "Run `grovie <command> --help` for command-specific usage.",
  ].join("\n");
}

function renderCommandHelp(command: CliCommand): string {
  return [
    `grovie ${command.name}`,
    "",
    command.description,
    "",
    "Usage:",
    `  ${command.usage}`,
    "",
    `Tracked by ${command.issue}.`,
  ].join("\n");
}

function formatIssueRepository(reference: { owner: string; repo: string }): string {
  return `${reference.owner}/${reference.repo}`;
}

function resolveManualRunAgent(input: {
  explicitAgentId: string | undefined;
  issueReference: { owner: string; repo: string; number: number };
  github: GitHubGateway;
  machineId: string;
}): { ok: true; agentId: string } | { ok: false; message: string } {
  if (input.explicitAgentId !== undefined) {
    parseAgentId(input.explicitAgentId);
    return {
      ok: true,
      agentId: input.explicitAgentId,
    };
  }

  const issueResult = input.github.readIssue(input.issueReference);

  if (!issueResult.ok) {
    return {
      ok: false,
      message: issueResult.error.message,
    };
  }

  const localAgentIds = getAssignedAgentIds(issueResult.value.labels)
    .filter((agentId) => agentId.endsWith(`@${input.machineId}`));

  if (localAgentIds.length === 0) {
    return {
      ok: false,
      message: `No local agent assignment found for ${formatIssueReference(input.issueReference)}. Pass --agent or add an agent:<name>@${input.machineId} label.`,
    };
  }

  if (localAgentIds.length > 1) {
    return {
      ok: false,
      message: `Multiple local agent assignments found for ${formatIssueReference(input.issueReference)}: ${localAgentIds.join(", ")}. Pass --agent to choose one.`,
    };
  }

  return {
    ok: true,
    agentId: localAgentIds[0] ?? "",
  };
}

function renderConfigSource(loaded: LoadedConfig): string {
  return loaded.path === undefined ? `defaults (no ${CONFIG_FILE_NAME} found)` : `${loaded.path} is valid.`;
}

function renderConfigPath(loaded: LoadedConfig): string {
  return loaded.path ?? "built-in defaults";
}

function renderGlobalConfigSource(path: string, watchedRepositoryCount: number): string {
  const repositoryText = watchedRepositoryCount === 1 ? "1 watched repository" : `${watchedRepositoryCount} watched repositories`;
  return `${path} (${repositoryText}).`;
}

function enqueueDaemonRunRequest(input: {
  context: CliContext;
  repository: string;
  issueNumber: number;
  agentId: string;
  sourceRunId?: string;
  reason: "retry" | "rerun";
  title: string;
  action: string;
  mode: string;
}): CliResult {
  const identity = resolveLocalIdentity();
  const issueReference = parseIssueReference(`${input.repository}#${input.issueNumber}`);

  if (!issueReference.ok) {
    return githubErrorResult(issueReference.error);
  }

  if (input.context.localState.isDaemonRunning?.(identity.machineId) !== true) {
    return {
      exitCode: 1,
      stderr: `No Grovie daemon is running for machine ${identity.machineId}. Start one with \`grovie daemon start\`.`,
    };
  }

  if (input.context.localState.hasExecutionLock?.({
    repository: input.repository,
    issueNumber: input.issueNumber,
    agentId: input.agentId,
  }) === true) {
    return {
      exitCode: 1,
      stderr: `Grovie execution is already active for ${formatIssueReference(issueReference.value)} and ${input.agentId}.`,
    };
  }

  const request = input.context.localState.enqueueRunRequest?.({
    repository: input.repository,
    issueNumber: input.issueNumber,
    agentId: input.agentId,
    sourceRunId: input.sourceRunId,
    reason: input.reason,
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
      input.title,
      "",
      input.action,
      `Issue: ${formatIssueReference(issueReference.value)}`,
      `Agent: ${input.agentId}`,
      `Mode: ${input.mode}`,
      input.sourceRunId === undefined ? undefined : `Source run: ${input.sourceRunId}`,
      `Request: ${request.path}`,
    ].filter((line): line is string => line !== undefined).join("\n"),
  };
}

function readStringOption(
  args: string[],
  name: string,
): { ok: true; value: string | undefined } | { ok: false; result: CliResult } {
  const index = args.indexOf(name);

  if (index === -1) {
    return {
      ok: true,
      value: undefined,
    };
  }

  const value = args[index + 1];

  if (value === undefined || value.startsWith("-")) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: `Missing value for ${name}.`,
      },
    };
  }

  return {
    ok: true,
    value,
  };
}

function readNumberOption(
  args: string[],
  name: string,
): { ok: true; value: number | undefined } | { ok: false; result: CliResult } {
  const option = readStringOption(args, name);

  if (!option.ok) {
    return option;
  }

  if (option.value === undefined) {
    return {
      ok: true,
      value: undefined,
    };
  }

  const value = Number(option.value);

  if (!Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: `Invalid value for ${name}. Expected a positive integer.`,
      },
    };
  }

  return {
    ok: true,
    value,
  };
}

function errorResult(error: unknown): CliResult {
  return {
    exitCode: 1,
    stderr: error instanceof Error ? error.message : String(error),
  };
}

function githubErrorResult(error: { message: string }): CliResult {
  return {
    exitCode: 1,
    stderr: error.message,
  };
}

function renderStatusLine(label: string, message: string): string {
  return `${label}: ${message}${/[.!?]$/.test(message) ? "" : "."}`;
}
