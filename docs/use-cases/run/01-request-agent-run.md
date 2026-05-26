# UC-RUN-01: Request One Agent Run

> Users can request one concrete agent execution for a GitHub issue through the local daemon without changing long-lived assignment.

## Rules

| ID | Rule |
|----|------|
| R1 | `grovie run` requests one run and does not add or remove assignment labels. |
| R2 | The daemon, not the foreground CLI process, owns execution. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-01-S01 | P0 | A manual run for `owner/repo#123 --agent coder@machine` enqueues one daemon execution for that issue and agent without changing issue labels. |
| UC-RUN-01-S02 | P0 | A manual run when no daemon is running fails clearly and tells the user to start the daemon. |
| UC-RUN-01-S03 | P0 | A manual run without `--agent` uses the only local agent assigned on the issue. |
| UC-RUN-01-S04 | P0 | A manual run without `--agent` fails clearly when the issue has no local agent assignment. |
| UC-RUN-01-S05 | P0 | A manual run without `--agent` fails clearly when multiple local agents are assigned to the issue. |
| UC-RUN-01-S06 | P1 | A manual run for an agent that is already locked on the same issue reports the active run instead of starting a duplicate. |
