import {
  addWatchedRepository,
  CONFIG_FILE_NAME,
  createConfigFile,
  defaultConfig,
  loadConfig,
  loadGlobalConfig,
  removeWatchedRepository,
  saveGlobalConfig,
  type LoadedConfig,
} from "./config.js";
import { runDaemon, runDaemonForRepositories } from "./daemon.js";
import { GhGitHubGateway, type GitHubGateway, parseIssueReference } from "./github.js";
import { LocalState } from "./local-state.js";
import { runClaimedIssueAsync, type RunLocalState } from "./run.js";
import { CodexRuntime, type AgentRuntime } from "./runtime.js";
import { findLocalRun, listLocalRuns, renderRunDetail, renderRunsList } from "./status.js";
import { GROVIE_VERSION } from "./version.js";

export type CliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type CliContext = {
  cwd: string;
  github: GitHubGateway;
  runtime: AgentRuntime;
  localState: RunLocalState;
};

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

        if (!authenticatedUser.ok) {
          return githubErrorResult(authenticatedUser.error);
        }

        const runtimeAvailability = context.runtime.checkAvailability();
        const doctorOutput = [
          "grovie doctor",
          "",
          `Global config: ${renderGlobalConfigSource(globalConfig.path, globalConfig.config.watchedRepositories.length)}`,
          `Local policy config: ${renderConfigSource(loaded)}`,
          `Default runtime: ${loaded.config.runtime.default}`,
          `Queue label: ${loaded.config.queue.label}`,
          `GitHub: authenticated as ${authenticatedUser.value.login}.`,
          renderStatusLine("Codex", runtimeAvailability.message),
        ];

        if (!runtimeAvailability.available) {
          return {
            exitCode: 1,
            stdout: doctorOutput.join("\n"),
            stderr: "Codex runtime is not available. Install the Codex CLI or choose another runtime when one is supported.",
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

        return {
          exitCode: 0,
          stdout: renderRunsList(runs, "grovie status"),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  },
  {
    name: "runs",
    description: "Inspect local Grovie run history and logs.",
    usage: "grovie runs <list|show> [run-id]",
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

        return {
          exitCode: 1,
          stderr: "Missing runs subcommand. Usage: grovie runs <list|show> [run-id]",
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  },
  {
    name: "run",
    description: "Run one GitHub issue through a local agent.",
    usage: "grovie run owner/repo#123 --agent codex",
    issue: "#7",
    run: (args: string[], context: CliContext) => {
      const issueRef = args.find((arg) => parseIssueReference(arg).ok);

      if (issueRef === undefined) {
        return {
          exitCode: 1,
          stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
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
        const config = defaultConfig();

        const agent = agentOption.value ?? config.runtime.default;

        if (agent !== "codex") {
          return {
            exitCode: 1,
            stderr: `Unsupported agent runtime: ${agent}. Only codex is supported.`,
          };
        }

        return runClaimedIssueAsync({
          issueReference: parsedIssueReference.value,
          repository: targetRepository,
          config,
          configPath: "built-in defaults",
          agent,
          github: context.github,
          runtime: context.runtime,
          localState: context.localState,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  },
  {
    name: "daemon",
    description: "Watch GitHub issues by label and run them locally.",
    usage: "grovie daemon [--repo owner/repo] [--label grovie] [--once]",
    issue: "#8",
    run: (args: string[], context: CliContext) => {
      const repoOption = readStringOption(args, "--repo");

      if (!repoOption.ok) {
        return repoOption.result;
      }

      const labelOption = readStringOption(args, "--label");

      if (!labelOption.ok) {
        return labelOption.result;
      }

      try {
        const config = defaultConfig();

        if (repoOption.value !== undefined) {
          return runDaemon({
            repository: repoOption.value,
            label: labelOption.value ?? config.queue.label,
            config,
            configPath: "built-in defaults",
            github: context.github,
            runtime: context.runtime,
            localState: context.localState,
            once: args.includes("--once"),
          });
        }

        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);

        return runDaemonForRepositories({
          repositories: globalConfig.config.watchedRepositories.map((watchedRepository) => ({
            repository: watchedRepository.repository,
            label: labelOption.value ?? watchedRepository.label ?? config.queue.label,
          })),
          config,
          configPath: "built-in defaults",
          github: context.github,
          runtime: context.runtime,
          localState: context.localState,
          once: args.includes("--once"),
        });
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
    runtime: context.runtime ?? new CodexRuntime(),
    localState: context.localState ?? new LocalState(),
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

function renderConfigSource(loaded: LoadedConfig): string {
  return loaded.path === undefined ? `defaults (no ${CONFIG_FILE_NAME} found)` : `${loaded.path} is valid.`;
}

function renderGlobalConfigSource(path: string, watchedRepositoryCount: number): string {
  const repositoryText = watchedRepositoryCount === 1 ? "1 watched repository" : `${watchedRepositoryCount} watched repositories`;
  return `${path} (${repositoryText}).`;
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
