import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parseRepositoryName } from "./github.js";

export const CONFIG_FILE_NAME = ".grovie.yml";
export const GLOBAL_CONFIG_FILE_NAME = "config.yml";

export const repositoryNameSchema = z.string().regex(
  /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/,
  "must use the owner/repo format",
);

export const configSchema = z.strictObject({
  version: z.literal(1),
  runtime: z.strictObject({
    default: z.literal("codex"),
  }),
  queue: z.strictObject({
    label: z.string().min(1, "must not be empty"),
  }),
  branches: z.strictObject({
    prefix: z.string().min(1, "must not be empty"),
  }),
  worktrees: z.strictObject({
    cleanup: z.enum(["on-success", "never"]),
  }),
  pullRequests: z.strictObject({
    create: z.boolean(),
    draft: z.boolean(),
  }),
  comments: z.strictObject({
    mode: z.literal("concise"),
  }),
  safety: z.strictObject({
    allowDefaultBranchPush: z.literal(false),
  }),
});

export type GrovieConfig = z.infer<typeof configSchema>;

export type LoadedConfig = {
  path?: string;
  config: GrovieConfig;
};

export const globalConfigSchema = z.strictObject({
  version: z.literal(1),
  watchedRepositories: z.array(z.strictObject({
    repository: repositoryNameSchema,
    label: z.string().min(1, "must not be empty").optional(),
  })),
  adminConsole: z.strictObject({
    enabled: z.boolean(),
    host: z.literal("127.0.0.1").optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }).optional(),
});

export type GlobalGrovieConfig = z.infer<typeof globalConfigSchema>;

export type LoadedGlobalConfig = {
  path: string;
  config: GlobalGrovieConfig;
};

export type WatchedRepository = GlobalGrovieConfig["watchedRepositories"][number];

export function getConfigPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

export function createConfigFile(cwd: string): string {
  const configPath = getConfigPath(cwd);

  if (existsSync(configPath)) {
    throw new Error(`${CONFIG_FILE_NAME} already exists. Edit it directly or remove it before running grovie init.`);
  }

  writeFileSync(configPath, renderDefaultConfig(), "utf8");
  return configPath;
}

export function loadConfig(cwd: string): LoadedConfig {
  const configPath = getConfigPath(cwd);

  if (!existsSync(configPath)) {
    return {
      config: defaultConfig(),
    };
  }

  let parsed: unknown;

  try {
    parsed = parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${CONFIG_FILE_NAME}: ${message}`);
  }

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(renderValidationError(result.error));
  }

  return {
    path: configPath,
    config: result.data,
  };
}

export function getGlobalConfigPath(root: string): string {
  return join(root, GLOBAL_CONFIG_FILE_NAME);
}

export function loadGlobalConfig(root: string): LoadedGlobalConfig {
  const configPath = getGlobalConfigPath(root);

  if (!existsSync(configPath)) {
    return {
      path: configPath,
      config: defaultGlobalConfig(),
    };
  }

  let parsed: unknown;

  try {
    parsed = parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${configPath}: ${message}`);
  }

  const result = globalConfigSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(renderValidationError(result.error, configPath));
  }

  return {
    path: configPath,
    config: result.data,
  };
}

export function saveGlobalConfig(root: string, config: GlobalGrovieConfig): string {
  const configPath = getGlobalConfigPath(root);
  const result = globalConfigSchema.safeParse(config);

  if (!result.success) {
    throw new Error(renderValidationError(result.error, configPath));
  }

  mkdirSync(root, { recursive: true });
  writeFileSync(configPath, renderGlobalConfig(result.data), "utf8");
  return configPath;
}

export function addWatchedRepository(
  config: GlobalGrovieConfig,
  watchedRepository: WatchedRepository,
): GlobalGrovieConfig {
  assertValidRepository(watchedRepository.repository);

  const existing = config.watchedRepositories.find((candidate) => candidate.repository === watchedRepository.repository);
  const nextRepository = watchedRepository.label === undefined
    ? { repository: watchedRepository.repository }
    : { repository: watchedRepository.repository, label: watchedRepository.label };

  if (existing === undefined) {
    return {
      ...config,
      watchedRepositories: [...config.watchedRepositories, nextRepository],
    };
  }

  return {
    ...config,
    watchedRepositories: config.watchedRepositories.map((candidate) =>
      candidate.repository === watchedRepository.repository ? nextRepository : candidate,
    ),
  };
}

export function removeWatchedRepository(config: GlobalGrovieConfig, repository: string): GlobalGrovieConfig {
  assertValidRepository(repository);

  return {
    ...config,
    watchedRepositories: config.watchedRepositories.filter((candidate) => candidate.repository !== repository),
  };
}

export function inferGitHubRepository(cwd: string): string | undefined {
  let remoteUrl: string;

  try {
    remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }

  return parseGitHubRemote(remoteUrl);
}

export function parseGitHubRemote(remoteUrl: string): string | undefined {
  const patterns = [
    /^git@github\.com:(?<repository>[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/(?<repository>[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/(?<repository>[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(remoteUrl);
    const repository = match?.groups?.repository;

    if (repository !== undefined) {
      return repository;
    }
  }

  return undefined;
}

export function defaultConfig(): GrovieConfig {
  return {
    version: 1,
    runtime: {
      default: "codex",
    },
    queue: {
      label: "grovie",
    },
    branches: {
      prefix: "grovie/",
    },
    worktrees: {
      cleanup: "on-success",
    },
    pullRequests: {
      create: true,
      draft: false,
    },
    comments: {
      mode: "concise",
    },
    safety: {
      allowDefaultBranchPush: false,
    },
  };
}

export function defaultGlobalConfig(): GlobalGrovieConfig {
  return {
    version: 1,
    watchedRepositories: [],
    adminConsole: {
      enabled: false,
    },
  };
}

export function renderDefaultConfig(): string {
  return `# Grovie configuration.
# GitHub remains the source of truth; this file defines local runner policy.
version: 1

runtime:
  default: codex

queue:
  label: grovie

branches:
  prefix: grovie/

worktrees:
  # Keep failed worktrees for inspection; successful runs can be cleaned up.
  cleanup: on-success

pullRequests:
  create: true
  draft: false

comments:
  mode: concise

safety:
  # This must stay false. Grovie should never push directly to the default branch.
  allowDefaultBranchPush: false
`;
}

export function renderGlobalConfig(config: GlobalGrovieConfig): string {
  const watchedRepositories = config.watchedRepositories.length === 0
    ? "watchedRepositories: []"
    : [
      "watchedRepositories:",
      config.watchedRepositories
        .map((watchedRepository) => {
          const lines = [`  - repository: ${watchedRepository.repository}`];

          if (watchedRepository.label !== undefined) {
            lines.push(`    label: ${watchedRepository.label}`);
          }

          return lines.join("\n");
        })
        .join("\n"),
    ].join("\n");

  return `# Grovie global worker configuration.
# This file schedules repositories for the local daemon. It is not a security allowlist.
version: 1
${watchedRepositories}
adminConsole:
  enabled: ${config.adminConsole?.enabled ?? false}
${config.adminConsole?.host === undefined ? "" : `  host: ${config.adminConsole.host}\n`}${config.adminConsole?.port === undefined ? "" : `  port: ${config.adminConsole.port}\n`}`;
}

function assertValidRepository(repository: string): void {
  const result = parseRepositoryName(repository);

  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

function renderValidationError(error: z.ZodError, fileName = CONFIG_FILE_NAME): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : fileName;
    return `- ${path}: ${issue.message}`;
  });

  return [`Invalid ${fileName}:`, ...issues].join("\n");
}
