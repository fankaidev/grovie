# UC-GITHUB-01: Publish GitHub-Visible Run Summaries

> Grovie keeps GitHub issues useful for human coordination while leaving raw execution state in local storage or the optional state repo.

## Rules

| ID | Rule |
|----|------|
| R1 | GitHub issues own collaboration state: labels, comments, branches, PRs, reviews, and CI state. |
| R2 | GitHub comments are human-visible summaries or cancellation input, not execution locks. |
| R3 | Full logs and prompts are not dumped into issue comments by default. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-GITHUB-01-S01 | P0 | A completed run updates its lifecycle issue comment with final run status, end timestamp, and result details. |
| UC-GITHUB-01-S02 | P0 | A run that opens a PR includes the PR link in the issue summary comment. |
| UC-GITHUB-01-S03 | P1 | A run with state repo sync configured includes a state repo path or link in the issue summary comment. |
| UC-GITHUB-01-S04 | P1 | A runtime failure with stdout or stderr keeps raw logs out of the issue comment and points to local or synced state instead. |
| UC-GITHUB-01-S05 | P1 | A daemon uses local execution locks for coordination and does not create or update advisory claim comments. |
| UC-GITHUB-01-S06 | P1 | A starting run posts or updates one lifecycle comment per agent on the issue with start timestamp, run id, run status, runtime, agent id, local machine id, branch, and run directory. |
