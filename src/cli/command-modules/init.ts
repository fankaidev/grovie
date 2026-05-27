import { copyFileSync, existsSync } from "node:fs";
import {
  defaultGlobalConfig,
  getGlobalConfigPath,
  inferGitHubRepository,
  saveGlobalConfig,
  type GlobalGrovieConfig,
} from "../../config.js";
import { parseRepositoryName } from "../../github.js";
import { SUPPORTED_RUNTIMES, type RuntimeAvailability, type RuntimeName } from "../../runtime.js";
import {
  checkRuntimeAvailability,
  errorResult,
} from "../command-support.js";
import type { CliCommand, CliContext, CliResult } from "../types.js";

type InitOptions = {
  yes: boolean;
  force: boolean;
  repository?: string;
  runtimes: RuntimeName[];
  adminConsole?: boolean;
};

const MANUAL_REPOSITORY_CHOICE = "m";
const SKIP_REPOSITORY_CHOICE = "s";

export const initCommand = {
  name: "init",
  description: "Create the global Grovie config.",
  usage: [
    "grovie init",
    "grovie init --yes [--force] [--repo owner/repo] [--runtime codex|claude-code|pi] [--admin-console|--no-admin-console]",
  ].join("\n"),
  run: (args: string[], context: CliContext): CliResult | Promise<CliResult> => {
    try {
      const parsed = parseInitOptions(args);

      if (!parsed.ok) {
        return parsed.result;
      }

      return runInit(parsed.value, context);
    } catch (error) {
      return errorResult(error);
    }
  },
} satisfies CliCommand;

function runInit(options: InitOptions, context: CliContext): CliResult | Promise<CliResult> {
  const root = context.localState.getPaths().root;
  const configPath = getGlobalConfigPath(root);
  const interactive = context.terminal.isInteractive && !options.yes;
  const exists = existsSync(configPath);

  if (exists && !options.force) {
    if (!interactive) {
      return {
        exitCode: 0,
        stdout: [
          "grovie init",
          "",
          `Existing config kept unchanged: ${configPath}`,
          "Use `grovie init --force --yes` to replace it.",
          "Run `grovie doctor` to validate it.",
        ].join("\n"),
      };
    }

    return confirm(context, `Global config already exists: ${configPath}\nReplace it? [y/N] `, false)
      .then((replace) => {
        if (!replace) {
          return {
            exitCode: 0,
            stdout: [
              "grovie init",
              "",
              `Existing config kept unchanged: ${configPath}`,
              "Run `grovie doctor` to validate it.",
            ].join("\n"),
          };
        }

        return writeInitConfig(options, context, configPath, exists, interactive);
      })
      .catch((error: unknown) => errorResult(error));
  }

  return writeInitConfig(options, context, configPath, exists, interactive);
}

function writeInitConfig(
  options: InitOptions,
  context: CliContext,
  configPath: string,
  exists: boolean,
  interactive: boolean,
): CliResult | Promise<CliResult> {
  const config = interactive
    ? buildInteractiveConfig(options, context)
    : buildNonInteractiveConfig(options);

  if (isPromise(config)) {
    return config
      .then((resolvedConfig) => saveInitConfig(context, configPath, exists, resolvedConfig))
      .catch((error: unknown) => errorResult(error));
  }

  return saveInitConfig(context, configPath, exists, config);
}

function saveInitConfig(context: CliContext, configPath: string, exists: boolean, config: GlobalGrovieConfig): CliResult {
  const backupPath = exists ? backupConfig(configPath) : undefined;

  saveGlobalConfig(context.localState.getPaths().root, config);

  return {
    exitCode: 0,
    stdout: [
      "grovie init",
      "",
      ...(backupPath === undefined ? [] : [`Backup written: ${backupPath}`]),
      `Wrote global config: ${configPath}`,
      "Run `grovie doctor` to validate it.",
      "Run `grovie daemon` to start processing issues.",
    ].join("\n"),
  };
}

function isPromise(value: GlobalGrovieConfig | Promise<GlobalGrovieConfig>): value is Promise<GlobalGrovieConfig> {
  return typeof (value as Promise<GlobalGrovieConfig>).then === "function";
}

async function buildInteractiveConfig(options: InitOptions, context: CliContext): Promise<GlobalGrovieConfig> {
  const repository = options.repository ?? await promptForRepository(context);
  const runtimeHealth = SUPPORTED_RUNTIMES.map((runtime) => checkRuntimeAvailability(context, runtime));
  const selectedRuntimes = options.runtimes.length > 0
    ? options.runtimes
    : await promptForRuntimes(context, runtimeHealth);
  const adminConsoleEnabled = options.adminConsole
    ?? await confirm(context, "Enable the local admin console on 127.0.0.1? [Y/n] ", true);

  return createConfig({
    repository,
    runtimes: selectedRuntimes,
    adminConsole: adminConsoleEnabled,
  });
}

function buildNonInteractiveConfig(options: InitOptions): GlobalGrovieConfig {
  return createConfig({
    repository: options.repository,
    runtimes: options.runtimes,
    adminConsole: options.adminConsole ?? false,
  });
}

function createConfig(input: { repository?: string; runtimes: RuntimeName[]; adminConsole: boolean }): GlobalGrovieConfig {
  return {
    ...defaultGlobalConfig(),
    agents: input.runtimes.map((runtime) => ({
      name: runtime,
      runtime,
    })),
    watchedRepositories: input.repository === undefined
      ? []
      : [
        {
          repository: input.repository,
        },
      ],
    adminConsole: input.adminConsole
      ? {
        enabled: true,
        host: "127.0.0.1",
      }
      : {
        enabled: false,
      },
  };
}

async function promptForRepository(context: CliContext): Promise<string | undefined> {
  const detected = inferGitHubRepository(context.cwd);
  const recent = readRecentRepositories(context)
    .filter((repository) => repository.repository !== detected)
    .slice(0, 9);
  const choices = [
    ...(detected === undefined ? [] : [{
      key: "1",
      repository: detected,
      label: `${detected} (detected from current directory)`,
    }]),
    ...recent.map((repository, index) => {
      const number = String(index + (detected === undefined ? 1 : 2));

      return {
        key: number,
        repository: repository.repository,
        label: `${repository.repository} (${repository.private ? "private" : "public"}, updated ${repository.updatedAt})`,
      };
    }),
  ];
  const defaultChoice = choices[0]?.key ?? SKIP_REPOSITORY_CHOICE;
  const lines = [
    "Which repository should Grovie watch?",
    ...choices.map((choice) => `${choice.key}. ${choice.label}`),
    `${MANUAL_REPOSITORY_CHOICE}. Enter manually`,
    `${SKIP_REPOSITORY_CHOICE}. Skip for now`,
  ];
  const answer = (await context.terminal.prompt(`${lines.join("\n")}\nChoose [${defaultChoice}]: `)).trim();
  const selected = answer.length === 0 ? defaultChoice : answer;

  if (selected === SKIP_REPOSITORY_CHOICE) {
    return undefined;
  }

  if (selected === MANUAL_REPOSITORY_CHOICE) {
    return promptForManualRepository(context);
  }

  const choice = choices.find((candidate) => candidate.key === selected || candidate.repository === selected);

  if (choice === undefined) {
    throw new Error(`Invalid repository choice: ${selected}`);
  }

  return choice.repository;
}

async function promptForManualRepository(context: CliContext): Promise<string | undefined> {
  const repository = (await context.terminal.prompt("Repository owner/repo (empty to skip): ")).trim();

  if (repository.length === 0) {
    return undefined;
  }

  const parsed = parseRepositoryName(repository);

  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  return repository;
}

async function promptForRuntimes(context: CliContext, runtimeHealth: RuntimeAvailability[]): Promise<RuntimeName[]> {
  const defaults = runtimeHealth
    .filter((runtime) => runtime.available)
    .map((runtime) => runtime.runtime);
  const defaultText = defaults.length === 0 ? "none" : defaults.join(",");
  const lines = [
    "Detected local runtimes:",
    ...runtimeHealth.map((runtime, index) => {
      const status = runtime.available ? runtime.message : "not found";
      return `${index + 1}. ${runtime.runtime} (${status})`;
    }),
    "Enter runtime names or numbers separated by commas. Use `none` to skip.",
  ];
  const answer = (await context.terminal.prompt(`${lines.join("\n")}\nEnable runtimes [${defaultText}]: `)).trim();

  if (answer.length === 0) {
    return defaults;
  }

  return parseRuntimeSelection(answer);
}

function parseRuntimeSelection(value: string): RuntimeName[] {
  if (value.toLowerCase() === "none") {
    return [];
  }

  const selected: RuntimeName[] = [];

  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const runtime = parseRuntimeName(part);

    if (selected.includes(runtime)) {
      continue;
    }

    selected.push(runtime);
  }

  return selected;
}

async function confirm(context: CliContext, question: string, defaultValue: boolean): Promise<boolean> {
  const answer = (await context.terminal.prompt(question)).trim().toLowerCase();

  if (answer.length === 0) {
    return defaultValue;
  }

  if (answer === "y" || answer === "yes") {
    return true;
  }

  if (answer === "n" || answer === "no") {
    return false;
  }

  throw new Error(`Expected yes or no, got ${answer}.`);
}

function readRecentRepositories(context: CliContext): Array<{ repository: string; private: boolean; updatedAt: string }> {
  const result = context.github.listRecentRepositories?.(20);

  if (result === undefined || !result.ok) {
    return [];
  }

  return result.value;
}

function backupConfig(configPath: string): string {
  const backupPath = `${configPath}.bak`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

function parseInitOptions(args: string[]): { ok: true; value: InitOptions } | { ok: false; result: CliResult } {
  const options: InitOptions = {
    yes: false,
    force: false,
    runtimes: [],
  };
  const seenSingleValueOptions = new Set<string>();
  const seenFlags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--yes") {
      options.yes = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--admin-console" || arg === "--no-admin-console") {
      if (seenFlags.has("--admin-console")) {
        return invalidArgs(`Duplicate option: ${arg}`);
      }

      seenFlags.add("--admin-console");
      options.adminConsole = arg === "--admin-console";
      continue;
    }

    if (arg === "--repo") {
      if (seenSingleValueOptions.has(arg)) {
        return invalidArgs(`Duplicate option: ${arg}`);
      }

      const value = args[index + 1];

      if (value === undefined || value.startsWith("-")) {
        return invalidArgs(`Missing value for ${arg}.`);
      }

      const parsed = parseRepositoryName(value);

      if (!parsed.ok) {
        return invalidArgs(parsed.error.message);
      }

      seenSingleValueOptions.add(arg);
      options.repository = value;
      index += 1;
      continue;
    }

    if (arg === "--runtime") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("-")) {
        return invalidArgs(`Missing value for ${arg}.`);
      }

      for (const runtime of parseRuntimeSelection(value)) {
        if (!options.runtimes.includes(runtime)) {
          options.runtimes.push(runtime);
        }
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return invalidArgs(`Unknown option: ${arg}`);
    }

    return invalidArgs(`Unexpected argument: ${arg}`);
  }

  return {
    ok: true,
    value: options,
  };
}

function parseRuntimeName(value: string): RuntimeName {
  const byIndex = Number.parseInt(value, 10);

  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= SUPPORTED_RUNTIMES.length) {
    return SUPPORTED_RUNTIMES[byIndex - 1]!;
  }

  if (SUPPORTED_RUNTIMES.includes(value as RuntimeName)) {
    return value as RuntimeName;
  }

  throw new Error(`Unsupported runtime: ${value}`);
}

function invalidArgs(message: string): { ok: false; result: CliResult } {
  return {
    ok: false,
    result: {
      exitCode: 1,
      stderr: message,
    },
  };
}
