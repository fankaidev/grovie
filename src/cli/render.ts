import type { CliCommand } from "./types.js";

export function renderHelp(commands: readonly CliCommand[]): string {
  const maxNameLength = Math.max(...commands.map((command) => command.name.length));
  const commandLines = commands
    .map((command) => "  " + command.name.padEnd(maxNameLength) + "  " + command.description)
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

export function renderCommandHelp(command: CliCommand): string {
  const usageLines = command.usage
    .split("\n")
    .map((line) => "  " + line);

  return [
    "grovie " + command.name,
    "",
    command.description,
    "",
    "Usage:",
    usageLines.join("\n"),
    "",
    "Tracked by " + command.issue + ".",
  ].join("\n");
}
