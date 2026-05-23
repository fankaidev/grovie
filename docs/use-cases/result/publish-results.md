# UC-RESULT-001: Publish Code Changes Safely

> Grovie turns agent worktree changes into GitHub-visible output without pushing directly to the default branch.

## Rules

| ID | Rule |
|----|------|
| R1 | Grovie never force-pushes over an existing remote branch. |
| R2 | Grovie refuses to push the default branch. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RESULT-001-S01 | P0 | A run with no worktree changes reports "no changes" on the issue and does not open a PR. |
| UC-RESULT-001-S02 | P0 | A run with worktree changes commits them, pushes the Grovie result branch, opens a PR, and links it from the issue. |
| UC-RESULT-001-S03 | P0 | A run whose result branch already exists remotely reports a publish conflict instead of overwriting it. |
| UC-RESULT-001-S04 | P0 | A run whose computed result branch is the default branch is rejected before any push. |
