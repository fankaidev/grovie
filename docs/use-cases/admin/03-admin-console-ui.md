# UC-ADMIN-03: Inspect Local State Through Admin Views

> The local admin console serves local-only React views for daemon status, configuration, repositories, and runs.

## Rules

| ID | Rule |
|----|------|
| R1 | Admin views are served by the opt-in local admin console server. |
| R2 | Admin views are inspection-focused and do not create a hosted dashboard. |
| R3 | Admin views link run list entries to local React run detail routes. |
| R4 | The admin home shows recent daemon activity so operators can see incoming changes and local actions without tailing process logs. |
| R5 | Production admin UI assets are served from the root build output under `dist/admin-web`. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-03-S01 | P2 | The React `GET /` route fetches admin APIs and shows daemon health, runtime availability, configured agent availability, useful paths, watched repositories, and recent runs. |
| UC-ADMIN-03-S02 | P2 | The React `/runs/:runId` route fetches run detail and shows issue reference, status, agent/runtime, run reason, source run, branch, worktree path, run directory, prompt/task paths, stdout/stderr paths, events, and GitHub result links. |
| UC-ADMIN-03-S03 | P2 | The React `/runs/:runId` route shows a clear not-found state for missing local runs. |
| UC-ADMIN-03-S04 | P1 | The React `GET /` route shows recent daemon activity entries with timestamp, type, repository, issue, agent, and message. |
| UC-ADMIN-03-S05 | P1 | When the admin web production build exists, `GET /`, hashed static asset paths, and SPA routes such as `/runs/:runId` are served from `dist/admin-web` while `/api/*` routes keep returning API responses. |
| UC-ADMIN-03-S06 | P1 | The React `GET /` route shows watched repositories, grouped recent runs, and recent activity as full-width sections from top to bottom, with recent runs grouped by issue and agent. |
