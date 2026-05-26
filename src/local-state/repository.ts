import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../github.js";
import type { LocalStatePaths } from "./types.js";
import { sanitizeRepository } from "./ids.js";

export function getRepositoryCachePath(paths: LocalStatePaths, repository: string): string {
  return join(paths.reposDir, `${sanitizeRepository(repository)}.git`);
}

export function ensureRepositoryCache(input: {
  paths: LocalStatePaths;
  runner: CommandRunner;
  repository: string;
  defaultBranch: string;
}): string {
  const cachePath = getRepositoryCachePath(input.paths, input.repository);

  ensureBareRepository({
    runner: input.runner,
    repository: input.repository,
    cachePath,
  });

  const fetchResult = input.runner.run("git", [
    "-C",
    cachePath,
    "fetch",
    "origin",
    `+refs/heads/${input.defaultBranch}:refs/heads/${input.defaultBranch}`,
  ]);

  if (fetchResult.exitCode !== 0) {
    throw new Error(fetchResult.stderr.trim() || `git fetch failed with exit code ${fetchResult.exitCode}.`);
  }

  return cachePath;
}

export function ensureWorktree(input: {
  runner: CommandRunner;
  repositoryCachePath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}): void {
  if (existsSync(input.worktreePath)) {
    return;
  }

  const pruneResult = input.runner.run("git", ["-C", input.repositoryCachePath, "worktree", "prune"]);

  if (pruneResult.exitCode !== 0) {
    throw new Error(pruneResult.stderr.trim() || `git worktree prune failed with exit code ${pruneResult.exitCode}.`);
  }

  const result = input.runner.run("git", [
    "-C",
    input.repositoryCachePath,
    "worktree",
    "add",
    "-B",
    input.branchName,
    input.worktreePath,
    input.baseBranch,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git worktree add failed with exit code ${result.exitCode}.`);
  }
}

function ensureBareRepository(input: {
  runner: CommandRunner;
  repository: string;
  cachePath: string;
}): void {
  if (existsSync(input.cachePath)) {
    return;
  }

  const remoteUrl = `https://github.com/${input.repository}.git`;
  const cloneResult = input.runner.run("git", ["clone", "--bare", remoteUrl, input.cachePath]);

  if (cloneResult.exitCode !== 0) {
    throw new Error(cloneResult.stderr.trim() || `git clone --bare failed with exit code ${cloneResult.exitCode}.`);
  }
}
