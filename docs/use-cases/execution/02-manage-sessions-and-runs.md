# UC-EXECUTION-02: Manage Agent Sessions and Runs

> Grovie keeps one long-lived session per issue and agent, with each trigger creating a concrete run inside that session.

## Rules

| ID | Rule |
|----|------|
| R1 | Session identity is keyed by `(issue, agent)`. |
| R2 | Run identity is deterministic and readable, with no random suffix. |
| R3 | The handled cursor is local and scoped to `(issue, agent)`. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-EXECUTION-02-S01 | P0 | The session for `fankaidev/grovie#123` and `coder@fankai-mac` is named `fankaidev-grovie-issue-123-coder-fankai-mac`. |
| UC-EXECUTION-02-S02 | P0 | A run in that session appends a UTC timestamp to the session id without adding a random suffix. |
| UC-EXECUTION-02-S03 | P0 | New issue activity after the handled cursor makes the assigned local agent eligible for another run. |
| UC-EXECUTION-02-S04 | P0 | Reprocessing an unchanged issue does not create another run for the same agent. |
| UC-EXECUTION-02-S05 | P0 | Two agents on the same issue keep separate handled cursors and can be at different points in the issue timeline. |
| UC-EXECUTION-02-S06 | P1 | If a generated run id would collide within the same second, the daemon waits, retries, or fails clearly rather than adding randomness. |
| UC-EXECUTION-02-S07 | P1 | `grovie runs list` shows concise run history with issue reference, agent, runtime, status, branch, result links, times, and log paths. |
| UC-EXECUTION-02-S08 | P1 | `grovie runs show <run-id>` shows readable run details with issue, worktree, run directory, stdout/stderr, events, branch, and GitHub result links. |
| UC-EXECUTION-02-S09 | P2 | `grovie runs retry <run-id>` enqueues a new daemon run for a failed, canceled, or stale run without overwriting the original run history. |
| UC-EXECUTION-02-S10 | P2 | `grovie runs rerun owner/repo#123 --agent coder@machine` enqueues a new daemon run in the existing issue-agent session and reports that the session worktree will be reused. |
| UC-EXECUTION-02-S11 | P2 | Retry and rerun refuse to enqueue a duplicate when the same issue-agent execution is already active locally. |
| UC-EXECUTION-02-S12 | P0 | A daemon restart rejects a resumable run whose agent id is not configured locally. |
| UC-EXECUTION-02-S13 | P0 | A daemon run request for an unconfigured local agent is rejected before runtime start. |
