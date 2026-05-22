import { createConfigFile, inferGitHubRepository, loadConfig } from "./config.js";
import { formatIssueReference, GhGitHubGateway, type GitHubGateway, parseIssueReference } from "./github.js";

export type CliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type CliContext = {
  cwd: string;
  github: GitHubGateway;
};

type CliCommand = {
  name: string;
  description: string;
  usage: string;
  issue: string;
  run: (args: string[], context: CliContext) => CliResult;
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

        return {
          exitCode: 0,
          stdout: [
            "grovie doctor",
            "",
            `Config: ${loaded.path} is valid.`,
            `Allowed repositories: ${loaded.config.repositories.allowed.join(", ")}`,
            `Default runtime: ${loaded.config.runtime.default}`,
            `Queue label: ${loaded.config.queue.label}`,
            `GitHub: authenticated as ${authenticatedUser.value.login}.`,
            "Agent runtime checks will be implemented in #6.",
          ].join("\n"),
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
    run: (args: string[]) => {
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

      return stubResult("run", `One-shot execution for ${formatIssueReference(parsedIssueReference.value)} will be implemented in #7.`);
    },
  },
  {
    name: "daemon",
    description: "Watch GitHub issues by label and run them locally.",
    usage: "grovie daemon --repo owner/repo --label grovie",
    issue: "#8",
    run: () => stubResult("daemon", "Issue polling and claim handling will be implemented in #8."),
  },
] satisfies CliCommand[];

export const commands: readonly CliCommand[] = commandDefinitions;

export function runCli(args: string[], context: Partial<CliContext> = {}): CliResult {
  const cliContext = {
    cwd: context.cwd ?? process.cwd(),
    github: context.github ?? new GhGitHubGateway(),
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
