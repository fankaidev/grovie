# UC-GITHUB-02: Discover Related Pull Requests

> Grovie gives assigned agents local pull request context so they can respond to implementation, review, CI, and follow-up activity without treating GitHub comments as execution locks.

## Rules

| ID | Rule |
|----|------|
| R1 | Related pull request context is copied into local run handoff state, not used as the source of execution locks. |
| R2 | Raw context snapshots remain local unless optional state repo sync explicitly supports a redacted remote view. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-GITHUB-02-S01 | P1 | A pull request whose branch or body references an issue is discovered as related to that issue. |
| UC-GITHUB-02-S02 | P1 | New related pull request activity after the handled cursor makes an assigned local agent eligible for another run. |
| UC-GITHUB-02-S03 | P1 | A run handoff includes related pull request title, state, branches, head SHA, checks, reviews, comments, review comments, and diff summary when available. |
| UC-GITHUB-02-S04 | P1 | Issue-only execution still works when no related pull request exists. |
