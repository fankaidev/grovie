# UC-ADMIN-02: Inspect Local State Through Admin APIs

> The local admin console exposes read-only APIs for daemon health, configuration, repositories, daemon activity, runs, and run events.

## Rules

| ID | Rule |
|----|------|
| R1 | Admin APIs are available only through the opt-in local admin console server. |
| R2 | Admin APIs must not expose environment variable values or secret values. |
| R3 | Run APIs read local run history from `~/.grovie/runs`. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-02-S01 | P2 | `GET /api/health` returns daemon status and runtime availability. |
| UC-ADMIN-02-S02 | P2 | `GET /api/config` returns global config without environment variables or secrets. |
| UC-ADMIN-02-S03 | P2 | `GET /api/repos` returns watched repositories and labels. |
| UC-ADMIN-02-S04 | P2 | `GET /api/runs` returns recent local runs with issue, status, branch, log paths, and result links. |
| UC-ADMIN-02-S05 | P2 | `GET /api/runs/:runId` returns a single run detail or a clear 404. |
| UC-ADMIN-02-S06 | P2 | `GET /api/runs/:runId/events` returns local run events or a clear 404. |
| UC-ADMIN-02-S07 | P1 | `GET /api/activity` returns recent daemon activity such as repository polls, received run requests, skipped queue candidates, and started or completed local actions. |
