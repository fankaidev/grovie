import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_FILE_NAME = ".grovie.yml";

const repositoryNameSchema = z.string().regex(
  /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/,
  "must use the owner/repo format",
);

export const configSchema = z.object({
  version: z.literal(1),
  repositories: z.object({
    allowed: z.array(repositoryNameSchema).min(1, "must include at least one repository"),
  }),
  runtime: z.object({
    default: z.literal("codex"),
  }),
  queue: z.object({
    label: z.string().min(1, "must not be empty"),
  }),
  branches: z.object({
    prefix: z.string().min(1, "must not be empty"),
  }),
  worktrees: z.object({
    cleanup: z.enum(["on-success", "never"]),
  }),
  pullRequests: z.object({
    create: z.boolean(),
    draft: z.boolean(),
  }),
  comments: z.object({
    mode: z.literal("concise"),
  }),
  safety: z.object({
    allowDefaultBranchPush: z.literal(false),
  }),
});

export type GrovieConfig = z.infer<typeof configSchema>;

export type LoadedConfig = {
  path: string;
  config: GrovieConfig;
};

export function getConfigPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

export function createConfigFile(cwd: string, repository: string): string {
  const configPath = getConfigPath(cwd);

  if (existsSync(configPath)) {
    throw new Error(`${CONFIG_FILE_NAME} already exists. Edit it directly or remove it before running grovie init.`);
  }

  const parsedRepository = repositoryNameSchema.safeParse(repository);

  if (!parsedRepository.success) {
    throw new Error(`Invalid repository "${repository}". Expected owner/repo.`);
  }

  writeFileSync(configPath, renderDefaultConfig(parsedRepository.data), "utf8");
  return configPath;
}

export function loadConfig(cwd: string): LoadedConfig {
  const configPath = getConfigPath(cwd);

  if (!existsSync(configPath)) {
    throw new Error(`Missing ${CONFIG_FILE_NAME}. Run \`grovie init\` first.`);
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

export function renderDefaultConfig(repository: string): string {
  return `# Grovie configuration.
# GitHub remains the source of truth; this file defines local runner policy.
version: 1

repositories:
  # Grovie refuses to run issues outside this allowlist.
  allowed:
    - ${repository}

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

function renderValidationError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : CONFIG_FILE_NAME;
    return `- ${path}: ${issue.message}`;
  });

  return [`Invalid ${CONFIG_FILE_NAME}:`, ...issues].join("\n");
}
