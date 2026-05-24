import type { GitHubIssue } from "./github.js";

export function hasCancelRequest(issue: GitHubIssue, queueLabel: string): boolean {
  const cancelLabel = `${queueLabel}:cancel`;

  return (
    issue.labels.includes(cancelLabel) ||
    issue.comments.some((comment) => comment.body.split("\n").some((line) => line.trim() === "/grovie cancel"))
  );
}
