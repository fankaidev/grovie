import { formatIssueReference, type CreatedComment, type GitHubGateway, type GitHubIssue, type IssueReference } from "../github.js";
import type { PreparedRun } from "../local-state.js";
import type { RuntimeName } from "../runtime.js";
import type { SessionStatus } from "../task.js";
import type { RunSummary } from "./types.js";
import { isReviewerRun } from "./helpers.js";

const RUN_MARKER = "grovie:run";
const AGENT_COMMENT_MARKER = "grovie:agent-comment";

export function renderAgentIssueComment(input: {
  agentId: string;
  body: string;
}): string {
  return [
    `<!-- ${AGENT_COMMENT_MARKER} ${JSON.stringify({ agentId: input.agentId })} -->`,
    `- Agent: \`${input.agentId}\``,
    "",
    input.body.trim(),
  ].join("\n");
}

export function upsertRunProgressComment(input: {
  issue: GitHubIssue;
  issueReference: IssueReference;
  github: GitHubGateway;
  run: PreparedRun;
  runtime: RuntimeName;
  agentId: string;
  machineId: string;
  startedAt: string;
}): { ok: true; action: "created" | "updated"; comment: CreatedComment } | { ok: false; error: string } {
  const body = renderRunProgressComment(input);
  const repository = formatIssueReference(input.issueReference).split("#")[0] ?? "";
  const previous = [...input.issue.comments]
    .reverse()
    .find((comment) => isRunProgressCommentForAgent(comment.body, input.agentId));
  const result = previous === undefined
    ? input.github.createIssueComment(input.issueReference, body)
    : input.github.updateIssueComment(repository, previous.id, body);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error.message,
    };
  }

  return {
    ok: true,
    action: previous === undefined ? "created" : "updated",
    comment: result.value,
  };
}

function renderRunProgressComment(input: {
  issue: GitHubIssue;
  run: PreparedRun;
  runtime: RuntimeName;
  agentId: string;
  machineId: string;
  startedAt: string;
}): string {
  const marker = `<!-- ${RUN_MARKER} ${JSON.stringify({
    phase: "progress",
    runId: input.run.runId,
    status: "running",
    runtime: input.runtime,
    agentId: input.agentId,
  })} -->`;
  return [
    marker,
    "Grovie run started.",
    "",
    "- Run status: running",
    `- Runtime: ${input.runtime}`,
    `- Agent: \`${input.agentId}\``,
    `- Machine: \`${input.machineId}\``,
    `- Issue: ${formatIssueReference(input.issue.reference)}`,
    `- Branch: \`${input.run.branchName}\` (local; not pushed)`,
    `- Run id: \`${input.run.runId}\``,
    `- Run directory: \`${input.run.runDir}\``,
    `- Started at: ${input.startedAt}`,
  ].join("\n");
}

export function renderRunResultComment(summary: RunSummary): string {
  const marker = `<!-- ${RUN_MARKER} ${JSON.stringify({
    phase: "result",
    runId: summary.runId,
    status: summary.status,
    runtime: summary.runtime,
    agentId: summary.agentId,
  })} -->`;
  const lines = [
    marker,
    "Grovie run finished.",
    "",
    `- Runtime: ${summary.runtime}`,
    `- Agent: \`${summary.agentId}\``,
    `- Machine: \`${summary.machineId}\``,
    `- Issue: ${formatIssueReference(summary.issue.reference)}`,
    `- Branch: \`${summary.branchName}\` (local; not pushed)`,
    `- Run id: \`${summary.runId}\``,
    `- Run directory: \`${summary.runDir}\``,
    `- Started at: ${summary.startedAt ?? "(unknown)"}`,
    "",
    "Result:",
    "",
    `- Run status: ${summary.status}`,
    `- Ended at: ${summary.endedAt ?? "(unknown)"}`,
  ];

  if (summary.error !== undefined) {
    lines.push(`- Error: ${summarizeError(summary)}`);
  }

  if (summary.result?.action !== undefined) {
    lines.push(`- Result action: ${summary.result.action}`);
  }

  if (summary.result?.reason !== undefined) {
    lines.push(`- Reason: ${summary.result.reason}`);
  }

  if (summary.result?.kind === "no-changes") {
    lines.push("- Changes: none");

    if (isReviewerRun(summary.agentId)) {
      lines.push(`- Review output: ${summarizeOutput(summary.result.validationSummary)}`);
    }
  }

  if (summary.result?.kind === "pull-request") {
    lines.push(`- Pull request: ${summary.result.pullRequest.url}`);
  }

  if (summary.result?.kind === "issue-comment") {
    lines.push(`- Issue comment: ${summary.result.comment.url}`);
  }

  if (summary.stateRepo !== undefined) {
    lines.push(`- State repo ${summary.stateRepo.status}: ${summary.stateRepo.target}`);
  }

  return lines.join("\n");
}

function isRunProgressCommentForAgent(body: string, agentId: string): boolean {
  const marker = body.match(/^<!-- grovie:run (\{.*\}) -->/);

  if (marker === null) {
    return false;
  }

  try {
    const metadata = JSON.parse(marker[1]) as { phase?: unknown; agentId?: unknown };
    return metadata.phase === "progress" && metadata.agentId === agentId;
  } catch {
    return false;
  }
}

export function runEventType(status: SessionStatus): "run.succeeded" | "run.failed" | "run.canceled" {
  if (status === "succeeded") {
    return "run.succeeded";
  }

  return status === "canceled" ? "run.canceled" : "run.failed";
}

export function renderCliRunOutput(summary: RunSummary): string {
  const lines = [
    "grovie daemon run",
    "",
    `Run status: ${summary.status}`,
    `Issue: ${formatIssueReference(summary.issue.reference)}`,
    `Branch: ${summary.branchName}`,
    `Run id: ${summary.runId}`,
    `Run directory: ${summary.runDir}`,
  ];

  if (summary.comment !== undefined) {
    lines.push(`Comment: ${summary.comment.url}`);
  }

  if (summary.result?.action !== undefined) {
    lines.push(`Result action: ${summary.result.action}`);
  }

  if (summary.result?.reason !== undefined) {
    lines.push(`Reason: ${summary.result.reason}`);
  }

  if (summary.result?.kind === "no-changes") {
    lines.push("Changes: none");
  }

  if (summary.result?.kind === "pull-request") {
    lines.push(`Pull request: ${summary.result.pullRequest.url}`);
  }

  if (summary.result?.kind === "issue-comment") {
    lines.push(`Issue comment: ${summary.result.comment.url}`);
  }

  return lines.join("\n");
}

function summarizeError(summary: RunSummary): string {
  if (summary.errorSource === "runtime") {
    return "Runtime failed. See the local run directory for stdout and stderr.";
  }

  return summarizeOutput(summary.error ?? "Run failed.");
}

function summarizeOutput(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 297)}...` : singleLine;
}
