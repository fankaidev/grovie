# UC-ADMIN-03: Inspect Local State Through Admin Views

> The local admin console serves simple local-only HTML views for daemon status, configuration, repositories, and runs.

## Rules

| ID | Rule |
|----|------|
| R1 | Admin views are served by the opt-in local admin console server. |
| R2 | Admin views are inspection-focused and do not create a hosted dashboard. |
| R3 | Admin views link run list entries to local run detail pages. |
| R4 | The admin home shows recent daemon activity so operators can see incoming changes and local actions without tailing process logs. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-03-S01 | P2 | `GET /` shows local machine context, daemon health, runtime availability, watched repositories, and recent runs. |
| UC-ADMIN-03-S02 | P2 | `GET /runs/:runId` shows issue reference, status, agent/runtime, run reason, branch, worktree path, run directory, prompt/task paths, stdout/stderr paths, result summary, events, and GitHub result links. |
| UC-ADMIN-03-S03 | P2 | `GET /runs/:runId` returns a clear not-found page for missing local runs. |
| UC-ADMIN-03-S04 | P1 | `GET /` shows recent daemon activity entries with timestamp, type, repository, issue, agent, and message. |
