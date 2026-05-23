# UC-EXECUTION-05: Publish Code Changes Safely

> Grovie turns agent worktree changes into GitHub-visible output without pushing directly to the default branch.

## Rules

| ID | Rule |
|----|------|
| R1 | Grovie never force-pushes over an existing remote branch. |
| R2 | Grovie refuses to push the default branch. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-EXECUTION-05-S01 | P0 | A run with no worktree changes reports "no changes" on the issue and does not open a PR. |
| UC-EXECUTION-05-S02 | P0 | A coder run with worktree changes commits them, pushes the agent's session branch, opens a PR, and links it from the issue. |
| UC-EXECUTION-05-S03 | P0 | A run whose result branch already exists remotely reports a publish conflict instead of overwriting it. |
| UC-EXECUTION-05-S04 | P0 | A run whose computed result branch is the default branch is rejected before any push. |
| UC-EXECUTION-05-S05 | P1 | A reviewer run with no intended code changes posts concise review output without modifying the coder branch or opening a PR. |
