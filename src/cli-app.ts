import { createConfigFile, inferGitHubRepository, loadConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { GhGitHubGateway, type GitHubGateway, parseIssueReference } from "./github.js";
import { LocalState } from "./local-state.js";
import { runIssue, type RunLocalState } from "./run.js";
import { CodexRuntime, type AgentRuntime } from "./runtime.js";

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
    usage: "grovie init [--repo owner/repo]",
    issue: "#3",
    run: (args: string[], context: CliContext) => {
      const repositoryResult = resolveRepository(args, context.cwd);

      if (!repositoryResult.ok) {
        return repositoryResult.result;
      }

      try {
        createConfigFile(context.cwd, repositoryResult.repository);
      } catch (error) {
        return errorResult(error);
      }

      return {
        exitCode: 0,
        stdout: [
          "grovie init",
          "",
          `Created .grovie.yml for ${repositoryResult.repository}.`,
          "Run `grovie doctor` to validate it.",
        ].join("\n"),
      };
    },
  },
  {
    name: "doctor",
    description: "Check local prerequisites such as gh, git, and agent CLIs.",
    usage: "grovie doctor",
    issue: "#3",
    run: (_args: string[], context: CliContext) => {
      try {
        const loaded = loadConfig(context.cwd);
        const authenticatedUser = context.github.getAuthenticatedUser();

        if (!authenticatedUser.ok) {
          return githubErrorResult(authenticatedUser.error);
        }

        const runtimeAvailability = context.runtime.checkAvailability();
        const doctorOutput = [
          "grovie doctor",
          "",
          `Config: ${loaded.path} is valid.`,
          `Repository: ${loaded.config.repository}`,
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
        const loaded = loadConfig(context.cwd);
        const agent = agentOption.value ?? loaded.config.runtime.default;

        if (agent !== "codex") {
          return {
            exitCode: 1,
            stderr: `Unsupported agent runtime: ${agent}. Only codex is supported.`,
          };
        }

        return runIssue({
          issueReference: parsedIssueReference.value,
          config: loaded.config,
          configPath: loaded.path,
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
        const loaded = loadConfig(context.cwd);
        const repository = repoOption.value ?? loaded.config.repository;

        return runDaemon({
          repository,
          label: labelOption.value ?? loaded.config.queue.label,
          config: loaded.config,
          configPath: loaded.path,
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

function stubResult(commandName: string, message: string): CliResult {
  return {
    exitCode: 0,
    stdout: [`grovie ${commandName}`, "", message].join("\n"),
  };
}

type RepositoryResolution =
  | {
    ok: true;
    repository: string;
  }
  | {
    ok: false;
    result: CliResult;
  };

function resolveRepository(args: string[], cwd: string): RepositoryResolution {
  const repoOption = readStringOption(args, "--repo");

  if (!repoOption.ok) {
    return {
      ok: false,
      result: repoOption.result,
    };
  }

  if (repoOption.value !== undefined) {
    return {
      ok: true,
      repository: repoOption.value,
    };
  }

  const inferredRepository = inferGitHubRepository(cwd);

  if (inferredRepository === undefined) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stderr: "Could not infer GitHub repository from origin remote. Use: grovie init --repo owner/repo",
      },
    };
  }

  return {
    ok: true,
    repository: inferredRepository,
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
