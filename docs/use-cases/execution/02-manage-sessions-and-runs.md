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
| UC-EXECUTION-02-S03 | P0 | A new issue comment after the handled cursor makes the assigned local agent eligible for another run. |
| UC-EXECUTION-02-S04 | P0 | Reprocessing an unchanged issue does not create another run for the same agent. |
| UC-EXECUTION-02-S05 | P0 | Two agents on the same issue keep separate handled cursors and can be at different points in the issue timeline. |
| UC-EXECUTION-02-S06 | P1 | If a generated run id would collide within the same second, the daemon waits, retries, or fails clearly rather than adding randomness. |
