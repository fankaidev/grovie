# UC-RUN-05: Publish Agent Results Safely

> Grovie turns an agent's local result artifacts and worktree changes into GitHub-visible output without pushing directly to the default branch.

## Rules

| ID | Rule |
|----|------|
| R1 | Grovie never force-pushes over an existing remote branch. |
| R2 | Grovie refuses to push the default branch. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-05-S01 | P0 | A run with no worktree changes reports "no changes" on the issue and does not open a PR. |
| UC-RUN-05-S02 | P0 | A coder run with worktree changes commits them, pushes the agent's session branch, opens a PR, and links it from the issue. |
| UC-RUN-05-S03 | P0 | A run whose result branch already exists remotely reports a publish conflict instead of overwriting it. |
| UC-RUN-05-S04 | P0 | A run whose computed result branch is the default branch is rejected before any push. |
| UC-RUN-05-S05 | P1 | A reviewer run with no intended code changes posts concise review output without modifying the coder branch or opening a PR. |
| UC-RUN-05-S06 | P0 | A comment-only run writes `.grovie/issue-comment.md`, and Grovie publishes that body as an issue comment without requiring runtime GitHub auth. |
| UC-RUN-05-S07 | P0 | A run writes `.grovie/result.json` with action `no-op`, `request-human`, `handoff`, or `review`, and Grovie reports the action and short reason in the GitHub-visible run summary without opening a PR. |
| UC-RUN-05-S08 | P0 | A run writes `.grovie/result.json` with action `comment`, and Grovie publishes `comment.body` or the compatible `.grovie/issue-comment.md` body as an issue comment. |
| UC-RUN-05-S09 | P0 | A run writes `.grovie/result.json` with action `code-change` and worktree changes, and Grovie opens the normal PR while including the short reason in the PR body and run summary. |
| UC-RUN-05-S10 | P1 | A run writes a structured result action that conflicts with worktree changes, and Grovie rejects the result instead of silently publishing the wrong output. |
