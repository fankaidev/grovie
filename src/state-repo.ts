import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { StateRepoConfig } from "./config.js";
import type { CommandRunner, GitHubGateway } from "./github.js";
import { SpawnCommandRunner } from "./github.js";
import type { LocalStatePaths, PreparedRun } from "./local-state.js";

export type StateRepoSyncInput = {
  config?: StateRepoConfig;
  paths: LocalStatePaths;
  machineId: string;
  agentId?: string;
  run?: PreparedRun;
  summary?: Record<string, unknown>;
  now?: Date;
  runner?: CommandRunner;
};

export type StateRepoSyncResult =
  | {
    ok: true;
    skipped?: boolean;
    committed: boolean;
    path?: string;
  }
  | {
    ok: false;
    pendingPath: string;
    message: string;
  };

export type StateRepoInitInput = {
  root: string;
  github: GitHubGateway;
  owner?: string;
  repository?: string;
  branch?: string;
  syncIntervalSeconds?: number;
  now?: Date;
};

export type StateRepoInitResult = {
  repository: string;
  branch: string;
  localPath: string;
  syncIntervalSeconds: number;
  created: boolean;
};

const DEFAULT_STATE_REPO_NAME = "grovie-state";
const DEFAULT_STATE_REPO_BRANCH = "main";
const DEFAULT_SYNC_INTERVAL_SECONDS = 60;
const PENDING_FILE_NAME = ".grovie-sync-pending.json";

export function initStateRepository(input: StateRepoInitInput): StateRepoInitResult {
  const repository = input.repository ?? resolveDefaultStateRepository(input);
  const branch = input.branch ?? DEFAULT_STATE_REPO_BRANCH;
  const localPath = join(input.root, "state-repo");
  const syncIntervalSeconds = input.syncIntervalSeconds ?? DEFAULT_SYNC_INTERVAL_SECONDS;
  let created = false;

  const existing = input.github.readRepository?.(repository);

  if (existing !== undefined) {
    if (!existing.ok) {
      const createdResult = input.github.createRepository?.({
        repository,
        private: true,
      });

      if (createdResult === undefined) {
        throw new Error("GitHub gateway does not support state repo creation.");
      }

      if (!createdResult.ok) {
        throw new Error(createdResult.error.message);
      }

      created = true;
    }
  } else {
    const createdResult = input.github.createRepository?.({
      repository,
      private: true,
    });

    if (createdResult === undefined) {
      throw new Error("GitHub gateway does not support state repo creation.");
    }

    if (!createdResult.ok) {
      throw new Error(createdResult.error.message);
    }

    created = true;
  }

  return {
    repository,
    branch,
    localPath,
    syncIntervalSeconds,
    created,
  };
}

export function syncStateRepository(input: StateRepoSyncInput): StateRepoSyncResult {
  if (input.config === undefined || !input.config.enabled) {
    return {
      ok: true,
      skipped: true,
      committed: false,
    };
  }

  const repoPath = resolveStateRepoPath(input.paths, input.config);
  const pendingPath = join(repoPath, PENDING_FILE_NAME);

  try {
    const runner = input.runner ?? new SpawnCommandRunner();

    if (!existsSync(join(repoPath, ".git"))) {
      if (existsSync(pendingPath)) {
        unlinkSync(pendingPath);
      }

      mkdirSync(dirname(repoPath), { recursive: true });
      runRequired(runner, "git", [
        "clone",
        "--branch",
        input.config.branch,
        `https://github.com/${input.config.repository}.git`,
        repoPath,
      ]);
    }

    projectStateRepoFiles(input, repoPath);
    runRequired(runner, "git", ["-C", repoPath, "add", "."]);
    const status = runner.run("git", ["-C", repoPath, "status", "--porcelain"]);

    if (status.exitCode !== 0) {
      throw new Error(status.stderr.trim() || `git status failed with exit code ${status.exitCode}.`);
    }

    if (status.stdout.trim().length === 0) {
      removePendingMarker(pendingPath);
      return {
        ok: true,
        committed: false,
        path: repoPath,
      };
    }

    runRequired(runner, "git", ["-C", repoPath, "commit", "-m", `sync grovie state ${formatSyncTimestamp(input.now ?? new Date())}`]);
    const push = runner.run("git", ["-C", repoPath, "push", "origin", `HEAD:${input.config.branch}`]);

    if (push.exitCode !== 0) {
      runRequired(runner, "git", ["-C", repoPath, "pull", "--rebase", "origin", input.config.branch]);
      runRequired(runner, "git", ["-C", repoPath, "push", "origin", `HEAD:${input.config.branch}`]);
    }

    removePendingMarker(pendingPath);
    return {
      ok: true,
      committed: true,
      path: repoPath,
    };
  } catch (error) {
    const message = toErrorMessage(error);

    mkdirSync(repoPath, { recursive: true });
    writeJsonFile(pendingPath, {
      pending: true,
      repository: input.config.repository,
      branch: input.config.branch,
      failedAt: (input.now ?? new Date()).toISOString(),
      message,
    });

    return {
      ok: false,
      pendingPath,
      message,
    };
  }
}

export function projectStateRepoFiles(input: StateRepoSyncInput, repoPath = resolveStateRepoPath(input.paths, input.config)): void {
  mkdirSync(repoPath, { recursive: true });
  writeJsonFile(join(repoPath, "machines", `${sanitizePathPart(input.machineId)}.json`), {
    machineId: input.machineId,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  writeJsonFile(join(repoPath, "daemons", `${sanitizePathPart(input.machineId)}.json`), {
    machineId: input.machineId,
    pid: process.pid,
    updatedAt: (input.now ?? new Date()).toISOString(),
    heartbeatIsSchedulingLock: false,
  });
  writeJsonFile(join(repoPath, "heartbeats", `${sanitizePathPart(input.machineId)}.json`), {
    machineId: input.machineId,
    lastHeartbeatAt: (input.now ?? new Date()).toISOString(),
    note: "Heartbeat is observability data only and is not a real-time scheduling lock.",
  });

  if (input.agentId !== undefined) {
    writeJsonFile(join(repoPath, "agents", `${sanitizePathPart(input.agentId)}.json`), {
      agentId: input.agentId,
      machineId: input.machineId,
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
  }

  if (input.run !== undefined) {
    projectRunFiles(input, repoPath, input.run);
  }
}

export function redactStateRepoText(value: string): string {
  return stripIssuePromptSections(value)
    .replace(/(ghp_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+:\/\/[^:\s]+:[^@\s]+@[^\s]+/g, "[REDACTED_DATABASE_URL]")
    .replace(/\b(token|key|secret|password|database_url)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi, "$1=[REDACTED]");
}

export function resolveStateRepoPath(paths: LocalStatePaths, config: StateRepoConfig | undefined): string {
  return join(paths.root, "state-repo");
}

function resolveDefaultStateRepository(input: StateRepoInitInput): string {
  if (input.owner !== undefined) {
    return `${input.owner}/${DEFAULT_STATE_REPO_NAME}`;
  }

  const owners = input.github.listRepositoryOwners?.();

  if (owners === undefined) {
    const user = input.github.getAuthenticatedUser();

    if (!user.ok) {
      throw new Error(user.error.message);
    }

    return `${user.value.login}/${DEFAULT_STATE_REPO_NAME}`;
  }

  if (!owners.ok) {
    throw new Error(owners.error.message);
  }

  if (owners.value.length === 1) {
    return `${owners.value[0] ?? ""}/${DEFAULT_STATE_REPO_NAME}`;
  }

  throw new Error(`Multiple GitHub owners are available: ${owners.value.join(", ")}. Pass --owner to choose where to create ${DEFAULT_STATE_REPO_NAME}.`);
}

function projectRunFiles(input: StateRepoSyncInput, repoPath: string, run: PreparedRun): void {
  const runDir = join(repoPath, "runs", sanitizePathPart(run.runId));
  const sessionDir = join(repoPath, "sessions", sanitizePathPart(run.sessionId));
  const metadata = readJson(run.runDir, "metadata.json");
  const session = readJson(run.sessionDir, "session.json");

  writeJsonFile(join(runDir, "metadata.json"), relativizeAndRedact(metadata ?? {
    runId: run.runId,
    sessionId: run.sessionId,
    agentId: run.agentId,
    branchName: run.branchName,
  }, input.paths.root));
  writeJsonFile(join(sessionDir, "session.json"), relativizeAndRedact(session ?? {
    sessionId: run.sessionId,
    agentId: run.agentId,
    branchName: run.branchName,
  }, input.paths.root));
  copyRedactedTextFile(run.promptPath, join(runDir, "prompt.md"));
  copyRedactedTextFile(run.stdoutPath, join(runDir, "stdout.log"));
  copyRedactedTextFile(run.stderrPath, join(runDir, "stderr.log"));
  copyRedactedTextFile(run.eventsPath, join(runDir, "events.jsonl"));

  if (input.summary !== undefined) {
    writeJsonFile(join(runDir, "summary.json"), relativizeAndRedact(input.summary, input.paths.root));
  }
}

function copyRedactedTextFile(source: string, destination: string): void {
  if (!existsSync(source)) {
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, redactStateRepoText(readFileSync(source, "utf8")), "utf8");
}

function relativizeAndRedact(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return redactStateRepoText(relativizePath(value, root));
  }

  if (Array.isArray(value)) {
    return value.map((item) => relativizeAndRedact(item, root));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === "body" || key === "comments" || key === "taskPath") {
        return [key, "[omitted from state repo]"];
      }

      return [key, relativizeAndRedact(child, root)];
    }));
  }

  return value;
}

function relativizePath(value: string, root: string): string {
  return value.startsWith(root) ? relative(root, value) || "." : value;
}

function stripIssuePromptSections(value: string): string {
  return value
    .replace(/(^|\n)Body:\n[\s\S]*?\n\nComments:\n/g, "$1Body:\n[omitted from state repo]\n\nComments:\n")
    .replace(/(^|\n)Comments:\n[\s\S]*?\n\nTask JSON:\n/g, "$1Comments:\n[omitted from state repo]\n\nTask JSON:\n")
    .replace(/(^|\n)Task JSON:\n[\s\S]*$/g, "$1Task JSON:\n[omitted from state repo]\n")
    .replace(/"body":\s*"[^"]*"/g, '"body": "[omitted from state repo]"')
    .replace(/"comments":\s*\[[\s\S]*?\n\s*\]/g, '"comments": "[omitted from state repo]"');
}

function readJson(dir: string, name: string): unknown {
  const path = join(dir, name);

  if (!existsSync(path)) {
    return undefined;
  }

  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runRequired(runner: CommandRunner, command: string, args: string[]): void {
  const result = runner.run(command, args);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${result.exitCode}.`);
  }
}

function removePendingMarker(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function clearProjectedStateRepo(path: string): void {
  for (const entry of ["machines", "daemons", "heartbeats", "agents", "sessions", "runs"]) {
    rmSync(join(path, entry), { recursive: true, force: true });
  }
}

function formatSyncTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
