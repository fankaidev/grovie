# UC-RUN-03: Publish Agent Results Safely

> Grovie turns an agent's local result artifacts and worktree changes into GitHub-visible output without pushing directly to the default branch.

## Rules

| ID | Rule |
|----|------|
| R1 | Grovie never force-pushes over an existing remote branch. |
| R2 | Grovie refuses to push the default branch. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-03-S01 | P0 | A run with no worktree changes reports "no changes" on the issue and does not open a PR. |
| UC-RUN-03-S02 | P0 | A coder run with worktree changes commits them, pushes the agent's session branch, opens a PR, and links it from the issue. |
| UC-RUN-03-S03 | P0 | A run whose result branch already exists remotely reports a publish conflict instead of overwriting it. |
| UC-RUN-03-S04 | P0 | A run whose computed result branch is the default branch is rejected before any push. |
| UC-RUN-03-S05 | P1 | A reviewer run with no intended code changes posts concise review output without modifying the coder branch or opening a PR. |
| UC-RUN-03-S06 | P0 | A comment-only run writes `.grovie/runs/<runId>/issue-comment.md` inside the prepared worktree, and Grovie publishes that body as an issue comment with visible agent attribution and without requiring runtime GitHub auth. |
| UC-RUN-03-S07 | P0 | A run writes `.grovie/runs/<runId>/result.json` inside the prepared worktree with action `no-op`, `request-human`, `handoff`, or `review`, and Grovie reports the action and short reason in the GitHub-visible run summary without opening a PR. |
| UC-RUN-03-S08 | P0 | A run writes `.grovie/runs/<runId>/result.json` with action `comment`, and Grovie publishes `comment.body` or the compatible `.grovie/runs/<runId>/issue-comment.md` body as an issue comment with visible agent attribution. |
| UC-RUN-03-S09 | P0 | A run writes `.grovie/runs/<runId>/result.json` with action `code-change` and worktree changes, and Grovie opens the normal PR while including the short reason in the PR body and run summary. |
| UC-RUN-03-S11 | P0 | A persistent worktree may contain stale `.grovie/issue-comment.md` or `.grovie/result.json` files from earlier versions, but Grovie ignores those files when handling the current run result. |
| UC-RUN-03-S10 | P1 | A run writes a structured result action that conflicts with worktree changes, and Grovie rejects the result instead of silently publishing the wrong output. |
| UC-RUN-03-S12 | P1 | A run that exits zero but records a known runtime tool write rejection and produces no explicit result artifact is rejected instead of being silently reported as a normal no-change run. |
| UC-RUN-03-S13 | P1 | A run that writes a valid `.grovie/runs/<runId>/issue-comment.md` and an invalid `.grovie/runs/<runId>/result.json` still publishes the explicit comment artifact instead of failing the run on the redundant invalid result artifact. |
