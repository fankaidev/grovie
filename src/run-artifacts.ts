import { join } from "node:path";
import type { PreparedRun } from "./local-state.js";

export function getRunHandoffDir(run: PreparedRun): string {
  return join(run.worktreePath, ".grovie", "runs", run.runId);
}

export function getIssueCommentArtifactPath(run: PreparedRun): string {
  return join(getRunHandoffDir(run), "issue-comment.md");
}

export function getResultArtifactPath(run: PreparedRun): string {
  return join(getRunHandoffDir(run), "result.json");
}

export function getRelativeIssueCommentArtifactPath(run: PreparedRun): string {
  return `.grovie/runs/${run.runId}/issue-comment.md`;
}

export function getRelativeResultArtifactPath(run: PreparedRun): string {
  return `.grovie/runs/${run.runId}/result.json`;
}
