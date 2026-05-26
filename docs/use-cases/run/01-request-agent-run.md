# UC-RUN-01: Trigger One Agent Run

> Users trigger concrete agent executions through visible GitHub issue activity, while the local daemon owns scheduling and execution.

## Rules

| ID | Rule |
|----|------|
| R1 | GitHub is the control plane for run triggers: labels, issue comments, pull request activity, and handled cursors decide whether an assigned agent should run. |
| R2 | The daemon, not the foreground CLI process, owns execution. |
| R3 | Grovie does not maintain a second local request-file queue for explicit runs. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-01-S01 | P0 | The top-level CLI no longer registers `grovie run`. |
| UC-RUN-01-S02 | P0 | A user asks an assigned agent to act again by adding visible GitHub issue activity, such as a new issue comment. |
| UC-RUN-01-S03 | P0 | The daemon picks up visible unhandled GitHub issue activity through the normal queue polling path. |
| UC-RUN-01-S04 | P1 | Grovie does not write local request files under `~/.grovie/requests`. |
| UC-RUN-01-S05 | P1 | Follow-up run prompts include only effective issue activity since the previous handled cursor, while `.grovie/task.json` keeps the complete structured context and remains the source of truth. |
