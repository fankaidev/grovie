# UC-DAEMON-001: Process Assigned Issues

> A Grovie daemon watches configured repositories, starts runs for local assigned agents, and keeps execution serialized per issue and agent.

## Rules

| ID | Rule |
|----|------|
| R1 | A machine should have at most one active daemon. |
| R2 | Execution locks are local and keyed by `(issue, agent)`. |
| R3 | Different agents can work on the same issue independently. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-001-S01 | P0 | Starting a daemon when a live daemon lock already exists refuses to start a second daemon for the same machine. |
| UC-DAEMON-001-S02 | P0 | Starting a daemon with a stale daemon lock recovers the lock and continues from persisted local state. |
| UC-DAEMON-001-S03 | P0 | A daemon cycle with one issue assigned to a local agent and new unhandled activity creates one run for that `(issue, agent)`. |
| UC-DAEMON-001-S04 | P0 | A daemon cycle skips an assigned issue when the agent's handled cursor already covers the latest issue activity. |
| UC-DAEMON-001-S05 | P0 | A daemon cycle skips an assigned issue when a local execution lock already exists for the same `(issue, agent)`. |
| UC-DAEMON-001-S06 | P0 | An issue assigned to two local agents can create independent runs for both agents. |
| UC-DAEMON-001-S07 | P1 | A reviewer agent assigned before a PR exists can still run and decide from context that no action is needed. |
| UC-DAEMON-001-S08 | P1 | A daemon watching multiple repositories checks each configured repository for assigned local agents. |
