# UC-SESSION-01: Manage Agent Sessions and Runs

> Grovie keeps one long-lived session per issue and agent, with each trigger creating a concrete run inside that session.

## Rules

| ID | Rule |
|----|------|
| R1 | Session identity is keyed by `(issue, agent)`. |
| R2 | The handled cursor is local and scoped to `(issue, agent)`. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-SESSION-01-S01 | P0 | The session for `fankaidev/grovie#123` and `coder@fankai-mac` is named `fankaidev-grovie-issue-123-coder-fankai-mac`. |
| UC-SESSION-01-S02 | P0 | A run in that session appends a UTC timestamp to the session id without adding a random suffix. |
| UC-SESSION-01-S03 | P0 | New issue activity after the handled cursor makes the assigned local agent eligible for another run. |
| UC-SESSION-01-S04 | P0 | Reprocessing an unchanged issue does not create another run for the same agent. |
| UC-SESSION-01-S05 | P0 | Two agents on the same issue keep separate handled cursors and can be at different points in the issue timeline. |
| UC-SESSION-01-S06 | P1 | If a generated run id would collide within the same second, the daemon waits, retries, or fails clearly rather than adding randomness. |
| UC-SESSION-01-S07 | P1 | `grovie runs list` shows concise run history with issue reference, agent, runtime, status, branch, result links, times, and log paths. |
| UC-SESSION-01-S08 | P1 | `grovie runs show <run-id>` shows readable run details with issue, worktree, run directory, stdout/stderr, events, branch, and GitHub result links. |
| UC-SESSION-01-S09 | P2 | A daemon resume records source run metadata in the new run history without overwriting the original run history. |
| UC-SESSION-01-S10 | P2 | `grovie runs` does not expose retry or rerun subcommands that enqueue hidden local request files. |
| UC-SESSION-01-S11 | P2 | Users request another run by creating visible GitHub issue activity for the assigned agent. |
| UC-SESSION-01-S12 | P0 | A daemon restart rejects a resumable run whose agent id is not configured locally. |
| UC-SESSION-01-S13 | P0 | A daemon restart rejects a resumable run for an unconfigured local agent before runtime start. |
| UC-SESSION-01-S14 | P0 | A successful run that creates related pull request activity does not immediately make the same issue-agent runnable again. |
| UC-SESSION-01-S15 | P1 | `grovie runs list` defaults to a bounded recent history and supports filtering by status, repository, issue, and agent. |
