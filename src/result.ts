import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { GrovieConfig } from "./config.js";
import {
  formatIssueReference,
  type CreatedComment,
  type CreatedPullRequest,
  type GitHubGateway,
  type GitHubIssue,
} from "./github.js";
import { SpawnCommandRunner, type CommandRunner } from "./github.js";
import type { PreparedRun } from "./local-state.js";
import { getIssueCommentArtifactPath, getResultArtifactPath } from "./run-artifacts.js";
import type { RuntimeExecution, RuntimeName } from "./runtime.js";
import { renderAgentIssueComment } from "./run/comments.js";

export type ResultHandler = {
  handle(input: HandleRunResultInput): HandleRunResultResult;
};

export type HandleRunResultInput = {
  run: PreparedRun;
  issue: GitHubIssue;
  config: GrovieConfig;
  configPath: string;
  repository: string;
  runtime: RuntimeName;
  execution: RuntimeExecution;
};

export type HandleRunResultResult =
  | {
    kind: "no-changes";
    status: string;
    validationSummary: string;
    action?: AgentResultAction;
    reason?: string;
  }
  | {
    kind: "pull-request";
    status: string;
    validationSummary: string;
    commitSha: string;
    pullRequest: CreatedPullRequest;
    comment?: CreatedComment;
    action?: AgentResultAction;
    reason?: string;
  }
  | {
    kind: "issue-comment";
    status: string;
    validationSummary: string;
    comment: CreatedComment;
    action?: AgentResultAction;
    reason?: string;
  };

export type AgentResultAction = z.infer<typeof agentResultActionSchema>;

const agentResultActionSchema = z.enum([
  "no-op",
  "comment",
  "code-change",
  "review",
  "request-human",
  "handoff",
]);

const agentResultArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  action: agentResultActionSchema,
  reason: z.string().trim().min(1).max(300).optional(),
  comment: z.object({
    body: z.string().trim().min(1),
  }).optional(),
}).strict();

type AgentResultArtifact = z.infer<typeof agentResultArtifactSchema>;

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
    const issueComment = readIssueCommentArtifact(input.run);
    const agentResult = issueComment === undefined ? readAgentResultArtifact(input.run) : readOptionalAgentResultArtifact(input.run);
    const commentBody = resolveCommentBody(agentResult, issueComment);

    const createdComment = commentBody === undefined
      ? undefined
      : this.createAgentComment(input, commentBody);

    if (commentBody !== undefined && status.stdout.trim().length === 0) {
      return {
        kind: "issue-comment",
        status: "",
        validationSummary,
        comment: createdComment!,
        ...renderResultMetadata(agentResult),
      };
    }

    if (status.stdout.trim().length === 0) {
      const runtimeToolFailure = detectRuntimeToolFailure(input.run);

      if (runtimeToolFailure !== undefined && agentResult === undefined && issueComment === undefined) {
        throw new Error(runtimeToolFailure);
      }

      return {
        kind: "no-changes",
        status: "",
        validationSummary,
        ...renderResultMetadata(agentResult),
      };
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
        reason: agentResult?.reason,
      }),
      head: input.run.branchName,
      base: input.issue.defaultBranch,
      draft: false,
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
      ...(createdComment === undefined ? {} : { comment: createdComment }),
      ...renderResultMetadata(agentResult),
    };
  }

  private createAgentComment(input: HandleRunResultInput, body: string): CreatedComment {
    const commentResult = this.github.createIssueComment(input.issue.reference, renderAgentIssueComment({
      agentId: input.run.agentId,
      body,
    }));

    if (!commentResult.ok) {
      throw new Error(commentResult.error.message);
    }

    return commentResult.value;
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
  runtime: RuntimeName;
  validationSummary: string;
  reason?: string;
}): string {
  const lines = [
    `Closes #${input.issue.reference.number}`,
    "",
    "## Grovie",
    `- Source issue: ${formatIssueReference(input.issue.reference)}`,
    `- Run id: ${input.run.runId}`,
    `- Runtime: ${input.runtime}`,
    `- Agent: \`${input.run.agentId}\``,
    `- Branch: ${input.run.branchName}`,
  ];

  if (input.reason !== undefined) {
    lines.push(`- Reason: ${input.reason}`);
  }

  lines.push(
    "",
    "## Validation",
    input.validationSummary,
  );

  return lines.join("\n");
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

function readIssueCommentArtifact(run: PreparedRun): string | undefined {
  const path = getIssueCommentArtifactPath(run);

  if (!existsSync(path)) {
    return undefined;
  }

  const content = readText(path);

  return content.trim();
}

function readAgentResultArtifact(run: PreparedRun): AgentResultArtifact | undefined {
  const path = getResultArtifactPath(run);

  if (!existsSync(path)) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readText(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid run result.json: ${message}`);
  }

  const result = agentResultArtifactSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(`Invalid run result.json: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return result.data;
}

function readOptionalAgentResultArtifact(run: PreparedRun): AgentResultArtifact | undefined {
  try {
    return readAgentResultArtifact(run);
  } catch {
    return undefined;
  }
}

function resolveCommentBody(agentResult: AgentResultArtifact | undefined, issueComment: string | undefined): string | undefined {
  if (agentResult?.action !== "comment") {
    if (issueComment !== undefined && issueComment.length === 0) {
      throw new Error("Issue comment artifact issue-comment.md is empty.");
    }

    return issueComment;
  }

  const body = agentResult.comment?.body ?? issueComment;

  if (body === undefined || body.length === 0) {
    throw new Error("Agent result action comment requires comment.body or issue-comment.md.");
  }

  return body;
}

function renderResultMetadata(agentResult: AgentResultArtifact | undefined): { action?: AgentResultAction; reason?: string } {
  if (agentResult === undefined) {
    return {};
  }

  return {
    action: agentResult.action,
    ...(agentResult.reason === undefined ? {} : { reason: agentResult.reason }),
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function detectRuntimeToolFailure(run: PreparedRun): string | undefined {
  const stderr = readText(run.stderrPath);
  const stdout = readText(run.stdoutPath);
  const combined = `${stderr}\n${stdout}`;

  if (combined.includes("patch rejected: writing outside of the project")) {
    return "Runtime reported a tool write rejection outside the project and produced no result artifact.";
  }

  if (combined.includes("rejected by user approval settings")) {
    return "Runtime reported a tool approval rejection and produced no result artifact.";
  }

  return undefined;
}

function truncate(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 1_997)}...` : value;
}
