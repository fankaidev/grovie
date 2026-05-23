# UC-ADMIN-05: Request Safe Local Run Actions

> The local admin console can request cancellation for active local runs without adding destructive repository actions.

## Rules

| ID | Rule |
|----|------|
| R1 | The admin console supports canceling active local runs only. |
| R2 | Cancellation writes local run state and is consumed by the existing runtime cancellation path. |
| R3 | The admin console does not expose cleanup, branch deletion, force-push, merge, or secret-editing actions. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-05-S01 | P2 | `POST /api/runs/:runId/cancel` records a local cancellation request for an active run. |
| UC-ADMIN-05-S02 | P2 | A running runtime observes the local cancellation request and records a canceled run result through the existing path. |
| UC-ADMIN-05-S03 | P2 | Canceling a terminal or missing run fails clearly without creating destructive side effects. |
| UC-ADMIN-05-S04 | P2 | The run detail view shows a confirmation-gated cancel action for active runs only. |
