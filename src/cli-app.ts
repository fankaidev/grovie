export type CliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type CliCommand = {
  name: string;
  description: string;
  usage: string;
  issue: string;
  run: (args: string[]) => CliResult;
};

const commandDefinitions = [
  {
    name: "init",
    description: "Create the minimal Grovie project config.",
    usage: "grovie init",
    issue: "#3",
    run: () => stubResult("init", "Config initialization will be implemented in #3."),
  },
  {
    name: "doctor",
    description: "Check local prerequisites such as gh, git, and agent CLIs.",
    usage: "grovie doctor",
    issue: "#3",
    run: () => stubResult("doctor", "Environment checks will be implemented in #3, #4, and #6."),
  },
  {
    name: "run",
    description: "Run one GitHub issue through a local agent.",
    usage: "grovie run owner/repo#123 --agent codex",
    issue: "#7",
    run: (args: string[]) => {
      const issueRef = args.find(isIssueReference);

      if (issueRef === undefined) {
        return {
          exitCode: 1,
          stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
        };
      }

      return stubResult("run", `One-shot execution for ${issueRef} will be implemented in #7.`);
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

export function runCli(args: string[]): CliResult {
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

  return command.run(commandArgs);
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

function isIssueReference(value: string): boolean {
  return /^[^/\s#]+\/[^#\s]+#[1-9]\d*$/.test(value);
}
