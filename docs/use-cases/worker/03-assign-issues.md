# UC-WORKER-03: Assign Issues to Agents

> Users assign GitHub issues to concrete local agents with labels while keeping assignment separate from one-off execution.

## Rules

| ID | Rule |
|----|------|
| R1 | Assignment labels use `agent:<agent-id>`. |
| R2 | An issue can have multiple agent labels. |
| R3 | Assignment is long-lived issue state; manual runs do not change it by default. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-03-S01 | P0 | Assigning `owner/repo#123` to `coder@fankai-mac` adds the label `agent:coder@fankai-mac`. |
| UC-WORKER-03-S02 | P0 | Removing assignment from `owner/repo#123` removes only the matching `agent:coder@fankai-mac` label. |
| UC-WORKER-03-S03 | P0 | Assigning both `planner@fankai-mac` and `coder@fankai-mac` leaves both agent labels on the same issue. |
| UC-WORKER-03-S04 | P0 | A manual run for `coder@fankai-mac` starts one execution request without adding `agent:coder@fankai-mac` to the issue. |
| UC-WORKER-03-S05 | P1 | A daemon on `fankai-mac` ignores an issue assigned only to `coder@other-machine`. |
