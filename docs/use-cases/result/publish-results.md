# UC-RESULT-001: Publish Code Changes Safely

> Grovie turns agent worktree changes into GitHub-visible output without pushing directly to the default branch.

## Rules

| ID | Rule |
|----|------|
| R1 | A no-change run comments back without creating a commit or pull request. |
| R2 | A changed run commits to a Grovie branch and opens a pull request. |
| R3 | Grovie never force-pushes over an existing remote branch. |
| R4 | Grovie refuses to push the default branch. |

## Scenarios

| ID | Priority | Scenario | Rules |
|----|----------|----------|-------|
| UC-RESULT-001-S01 | P0 | A run with no worktree changes reports "no changes" on the issue and does not open a PR. | R1 |
| UC-RESULT-001-S02 | P0 | A run with code changes commits them, pushes a Grovie branch, opens a PR, and links it from the issue. | R2 |
| UC-RESULT-001-S03 | P0 | A remote branch conflict is reported as a publish failure instead of being overwritten. | R3 |
| UC-RESULT-001-S04 | P0 | Any attempt to publish the default branch is rejected before pushing. | R4 |
