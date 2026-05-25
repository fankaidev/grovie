import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { renderDefaultConfig, renderGlobalConfig } from "./config/render.js";
import { parseRepositoryName } from "./github.js";
import { buildAgentId, slugifyIdentityPart, type AgentMetadata } from "./identity.js";
import type { RuntimeName } from "./runtime.js";

export { renderDefaultConfig, renderGlobalConfig } from "./config/render.js";

export const CONFIG_FILE_NAME = ".grovie.yml";
export const GLOBAL_CONFIG_FILE_NAME = "config.yml";

export const repositoryNameSchema = z.string().regex(
  /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/,
  "must use the owner/repo format",
);
export const runtimeNameSchema = z.enum(["codex", "claude-code", "pi"] satisfies RuntimeName[]);
export const agentNameSchema = z.string()
  .min(1, "must not be empty")
  .refine((value) => slugifyIdentityPart(value).length > 0, "must contain at least one letter or number")
  .refine((value) => slugifyIdentityPart(value) !== "default", "default is reserved; configure a named local agent");

export const configSchema = z.strictObject({
  version: z.literal(1),
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
  trust: z.strictObject({
    trustedAuthors: z.array(z.string().min(1, "must not be empty")).default([]),
  }).optional(),
  safety: z.strictObject({
    allowDefaultBranchPush: z.literal(false),
  }),
});

export type GrovieConfig = z.infer<typeof configSchema>;

export type LoadedConfig = {
  path?: string;
  config: GrovieConfig;
};

export type RepositoryFileResult =
  | {
    exists: true;
    path: string;
    content: string;
  }
  | {
    exists: false;
    path: string;
  };

export type RepositoryPolicyReader = {
  readRepositoryFile?(input: { repository: string; path: string }): RepositoryFileResult;
};

export const globalConfigSchema = z.strictObject({
  version: z.literal(1),
  agents: z.array(z.strictObject({
    name: agentNameSchema,
    runtime: runtimeNameSchema,
    instructions: z.string().min(1, "must not be empty").optional(),
    model: z.string().min(1, "must not be empty").optional(),
    args: z.array(z.string()).default([]),
    envKeys: z.array(z.string().min(1, "must not be empty")).default([]),
  })).default([]),
  watchedRepositories: z.array(z.strictObject({
    repository: repositoryNameSchema,
    label: z.string().min(1, "must not be empty").optional(),
  })),
  stateRepo: z.strictObject({
    enabled: z.boolean(),
    repository: repositoryNameSchema,
    branch: z.string().min(1, "must not be empty"),
    localPath: z.string().min(1, "must not be empty").optional(),
    syncIntervalSeconds: z.number().int().min(10).max(3600),
  }).optional(),
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
export type StateRepoConfig = NonNullable<GlobalGrovieConfig["stateRepo"]>;
export type GlobalAgentConfig = GlobalGrovieConfig["agents"][number];

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

  return parseConfigText(readFileSync(configPath, "utf8"), configPath, CONFIG_FILE_NAME);
}

export function loadRepositoryConfig(repository: string, reader: RepositoryPolicyReader | undefined): LoadedConfig {
  const result = reader?.readRepositoryFile?.({
    repository,
    path: CONFIG_FILE_NAME,
  });

  if (result === undefined || !result.exists) {
    return {
      config: defaultConfig(),
    };
  }

  return parseConfigText(result.content, result.path, result.path);
}

function parseConfigText(content: string, configPath: string, errorName: string): LoadedConfig {
  let parsed: unknown;

  try {
    parsed = parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${errorName}: ${message}`);
  }

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(renderValidationError(result.error, errorName));
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

export function resolveConfiguredAgents(config: GlobalGrovieConfig, machineId: string): AgentMetadata[] {
  const agents = config.agents.map((agent) => ({
    agentId: buildAgentId(agent.name, machineId),
    name: slugifyIdentityPart(agent.name),
    machineId: slugifyIdentityPart(machineId),
    runtime: agent.runtime,
    instructions: agent.instructions,
    model: agent.model,
    args: agent.args,
    envKeys: agent.envKeys,
  }));
  const seen = new Set<string>();

  for (const agent of agents) {
    if (seen.has(agent.agentId)) {
      throw new Error(`Duplicate local agent id ${agent.agentId}. Agent names must be unique after normalization.`);
    }

    seen.add(agent.agentId);
  }

  return agents;
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
    agents: [],
    watchedRepositories: [],
    adminConsole: {
      enabled: false,
    },
  };
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
