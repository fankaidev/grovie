import { readFileSync } from "node:fs";
import type { GrovieConfig } from "./config.js";
import {
  formatIssueReference,
  type CreatedPullRequest,
  type GitHubGateway,
  type GitHubIssue,
} from "./github.js";
import { SpawnCommandRunner, type CommandRunner } from "./github.js";
import type { PreparedRun } from "./local-state.js";
import type { RuntimeExecution } from "./runtime.js";

export type ResultHandler = {
  handle(input: HandleRunResultInput): HandleRunResultResult;
};

export type HandleRunResultInput = {
  run: PreparedRun;
  issue: GitHubIssue;
  config: GrovieConfig;
  configPath: string;
  repository: string;
  runtime: "codex";
  execution: RuntimeExecution;
};

export type HandleRunResultResult =
  | {
    kind: "no-changes";
    status: string;
    validationSummary: string;
  }
  | {
    kind: "pull-request";
    status: string;
    validationSummary: string;
    commitSha: string;
    pullRequest: CreatedPullRequest;
  };

export class GitResultHandler implements ResultHandler {
  constructor(
    private readonly github: GitHubGateway,
    private readonly runner: CommandRunner = new SpawnCommandRunner(),
  ) {}

  handle(input: HandleRunResultInput): HandleRunResultResult {
    if (input.config.safety.allowDefaultBranchPush !== false) {
      throw new Error(`Invalid ${input.configPath}: safety.allowDefaultBranchPush must be false.`);
    }

    if (input.run.branchName === input.issue.defaultBranch) {
      throw new Error(`Refusing to push default branch ${input.issue.defaultBranch}.`);
    }

    const status = this.git(input.run.worktreePath, ["status", "--short", "--", ".", ":(exclude).grovie"]);
    const validationSummary = summarizeValidation(input.run);

    if (status.stdout.trim().length === 0) {
      return {
        kind: "no-changes",
        status: "",
        validationSummary,
      };
    }

    if (!input.config.pullRequests.create) {
      throw new Error("Pull request creation is disabled by config.");
    }

    this.git(input.run.worktreePath, ["add", "--all", "--", ".", ":(exclude).grovie"]);
    this.git(input.run.worktreePath, ["restore", "--staged", "--", ".grovie"], { allowFailure: true });
    this.git(input.run.worktreePath, [
      "commit",
      "-m",
      `grovie: ${input.issue.title}`,
      "-m",
      `Source issue: ${formatIssueReference(input.issue.reference)}`,
      "-m",
      `Run id: ${input.run.runId}`,
    ]);
    this.pushResultBranch(input);

    const commitSha = this.git(input.run.worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
    const pullRequestResult = this.github.createPullRequest({
      repository: input.repository,
      title: `grovie: ${input.issue.title}`,
      body: renderPullRequestBody({
        issue: input.issue,
        run: input.run,
        runtime: input.runtime,
        validationSummary,
      }),
      head: input.run.branchName,
      base: input.issue.defaultBranch,
      draft: input.config.pullRequests.draft,
    });

    if (!pullRequestResult.ok) {
      throw new Error(pullRequestResult.error.message);
    }

    return {
      kind: "pull-request",
      status: status.stdout,
      validationSummary,
      commitSha,
      pullRequest: pullRequestResult.value,
    };
  }

  private git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}) {
    const result = this.runner.run("git", args, undefined, { cwd });

    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed with exit code ${result.exitCode}.`);
    }

    return result;
  }

  private pushResultBranch(input: HandleRunResultInput): void {
    const result = this.runner.run("git", ["push", "-u", "origin", `HEAD:${input.run.branchName}`], undefined, {
      cwd: input.run.worktreePath,
    });

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `git push failed with exit code ${result.exitCode}.`;

      throw new Error(
        [
          `Could not push result branch ${input.run.branchName}.`,
          "Another Grovie worker may have already pushed this issue branch.",
          "Grovie will not force-push or overwrite remote work.",
          detail,
        ].join(" "),
      );
    }
  }
}

function renderPullRequestBody(input: {
  issue: GitHubIssue;
  run: PreparedRun;
  runtime: "codex";
  validationSummary: string;
}): string {
  return [
    `Closes #${input.issue.reference.number}`,
    "",
    "## Grovie",
    `- Source issue: ${formatIssueReference(input.issue.reference)}`,
    `- Run id: ${input.run.runId}`,
    `- Runtime: ${input.runtime}`,
    `- Branch: ${input.run.branchName}`,
    "",
    "## Validation",
    input.validationSummary,
  ].join("\n");
}

function summarizeValidation(run: PreparedRun): string {
  const stderr = readText(run.stderrPath).trim();
  const stdout = readText(run.stdoutPath).trim();

  if (stderr.length > 0) {
    return truncate(stderr);
  }

  if (stdout.length > 0) {
    return truncate(stdout);
  }

  return "No validation output captured.";
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function truncate(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 1_997)}...` : value;
}
