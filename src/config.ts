import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { renderGlobalConfig } from "./config/render.js";
import { parseRepositoryName } from "./github.js";
import { buildAgentId, slugifyIdentityPart, type AgentMetadata } from "./identity.js";
import type { RuntimeName } from "./runtime.js";

export { renderGlobalConfig } from "./config/render.js";

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

export const allowedAuthorsSchema = z.array(z.string().min(1, "must not be empty"))
  .min(1, "must include at least one login or *")
  .refine((value) => !value.includes("*") || value.length === 1, "* cannot be combined with GitHub logins");

export const trustPolicySchema = z.strictObject({
  allowedAuthors: allowedAuthorsSchema,
});

export const repositoryPolicySchema = z.strictObject({
  queue: z.strictObject({
    label: z.string().min(1, "must not be empty"),
  }),
  branches: z.strictObject({
    prefix: z.string().min(1, "must not be empty"),
  }),
  trust: trustPolicySchema.optional(),
  safety: z.strictObject({
    allowDefaultBranchPush: z.literal(false),
  }),
});

export type GrovieConfig = z.infer<typeof repositoryPolicySchema>;

export type LoadedConfig = {
  path?: string;
  config: GrovieConfig;
};

export const globalConfigSchema = z.strictObject({
  version: z.literal(1),
  agents: z.array(z.strictObject({
    name: agentNameSchema,
    runtime: runtimeNameSchema,
    instructions: z.string().min(1, "must not be empty").optional(),
    model: z.string().min(1, "must not be empty").optional(),
    envKeys: z.array(z.string().min(1, "must not be empty")).optional(),
  })),
  watchedRepositories: z.array(z.strictObject({
    repository: repositoryNameSchema,
    label: z.string().min(1, "must not be empty").optional(),
    branches: repositoryPolicySchema.shape.branches.optional(),
    trust: trustPolicySchema,
  })),
  stateRepo: z.strictObject({
    enabled: z.boolean(),
    repository: repositoryNameSchema,
    branch: z.string().min(1, "must not be empty"),
    syncIntervalSeconds: z.number().int().min(10).max(3600),
  }).optional(),
  daemon: z.strictObject({
    maxConcurrentRuns: z.number().int().min(1),
  }).default({
    maxConcurrentRuns: 3,
  }),
  adminConsole: z.strictObject({
    enabled: z.boolean(),
    host: z.string().min(1, "must not be empty").optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }).optional(),
});

type ParsedGlobalGrovieConfig = z.infer<typeof globalConfigSchema>;
export type GlobalGrovieConfig = Omit<ParsedGlobalGrovieConfig, "daemon"> & {
  daemon?: ParsedGlobalGrovieConfig["daemon"];
};

export type LoadedGlobalConfig = {
  path: string;
  config: GlobalGrovieConfig;
};

export type WatchedRepository = GlobalGrovieConfig["watchedRepositories"][number];
export type StateRepoConfig = NonNullable<GlobalGrovieConfig["stateRepo"]>;
export type GlobalAgentConfig = GlobalGrovieConfig["agents"][number];

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

export function resolveEnabledStateRepo(config: GlobalGrovieConfig): StateRepoConfig | undefined {
  return config.stateRepo?.enabled === true ? config.stateRepo : undefined;
}

export function resolveWatchedRepositoryConfig(watchedRepository: WatchedRepository | undefined): GrovieConfig {
  const defaults = defaultConfig();

  return {
    ...defaults,
    queue: {
      label: watchedRepository?.label ?? defaults.queue.label,
    },
    branches: watchedRepository?.branches ?? defaults.branches,
    ...(watchedRepository?.trust === undefined ? {} : { trust: watchedRepository.trust }),
  };
}

export function resolveAllowedIssueAuthors(
  config: GrovieConfig,
): { ok: true; value: string[] | undefined } | { ok: false; message: string } {
  const allowedAuthors = config.trust?.allowedAuthors;

  if (allowedAuthors !== undefined) {
    if (allowedAuthors.includes("*")) {
      return {
        ok: true,
        value: undefined,
      };
    }

    return {
      ok: true,
      value: allowedAuthors,
    };
  }

  return {
    ok: false,
    message: "Watched repository trust.allowedAuthors must be configured explicitly.",
  };
}

export function resolveRepositoryConfig(repository: string, globalConfig: LoadedGlobalConfig): LoadedConfig {
  const watchedRepository = globalConfig.config.watchedRepositories.find((candidate) => candidate.repository === repository);

  return {
    path: globalConfig.path,
    config: resolveWatchedRepositoryConfig(watchedRepository),
  };
}

export function resolveConfiguredAgents(config: GlobalGrovieConfig, machineId: string): AgentMetadata[] {
  const agents = config.agents.map((agent) => ({
    agentId: buildAgentId(agent.name, machineId),
    name: slugifyIdentityPart(agent.name),
    machineId: slugifyIdentityPart(machineId),
    runtime: agent.runtime,
    instructions: agent.instructions,
    model: agent.model,
    envKeys: agent.envKeys ?? [],
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

  if (existing === undefined) {
    return {
      ...config,
      watchedRepositories: [...config.watchedRepositories, watchedRepository],
    };
  }

  return {
    ...config,
    watchedRepositories: config.watchedRepositories.map((candidate) =>
      candidate.repository === watchedRepository.repository ? watchedRepository : candidate,
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
    queue: {
      label: "grovie",
    },
    branches: {
      prefix: "grovie/",
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
    daemon: {
      maxConcurrentRuns: 3,
    },
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

function renderValidationError(error: z.ZodError, fileName: string): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : fileName;
    return `- ${path}: ${issue.message}`;
  });

  return [`Invalid ${fileName}:`, ...issues].join("\n");
}
