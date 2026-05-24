# UC-ADMIN-04: View Run Logs Through Admin Console

> The local admin console exposes stdout and stderr for active and completed runs while keeping the streams distinguishable.

## Rules

| ID | Rule |
|----|------|
| R1 | Run log APIs read local run log files and do not require the original daemon process to still be alive. |
| R2 | stdout and stderr remain separate streams. |
| R3 | Log responses must not expose environment variable values added by Grovie itself. |
| R4 | Log response and Server-Sent Events payload metadata use the shared admin API contract types. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-04-S01 | P2 | `GET /api/runs/:runId/logs/stdout` returns the local stdout log for a run. |
| UC-ADMIN-04-S02 | P2 | `GET /api/runs/:runId/logs/stderr` returns the local stderr log for a run. |
| UC-ADMIN-04-S03 | P2 | `GET /api/runs/:runId/logs/stream?stream=stdout|stderr` keeps a Server-Sent Events connection open and sends appended log output for the selected stream. |
| UC-ADMIN-04-S04 | P2 | The React run detail route keeps stdout and stderr previews distinguishable and renders basic ANSI colors. |
| UC-ADMIN-04-S05 | P2 | Missing runs and invalid streams return clear errors. |
