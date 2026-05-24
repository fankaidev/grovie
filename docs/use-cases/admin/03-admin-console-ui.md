# UC-ADMIN-03: Inspect Local State Through Admin Views

> The local admin console serves simple local-only HTML views for daemon status, configuration, repositories, and runs.

## Rules

| ID | Rule |
|----|------|
| R1 | Admin views are served by the opt-in local admin console server. |
| R2 | Admin views are inspection-focused and do not create a hosted dashboard. |
| R3 | Admin views link run list entries to local run detail pages. |
| R4 | Production admin UI assets are served from the root build output under `dist/admin-web`. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-03-S01 | P2 | `GET /` shows local machine context, daemon health, runtime availability, watched repositories, and recent runs. |
| UC-ADMIN-03-S02 | P2 | `GET /runs/:runId` shows issue reference, status, agent/runtime, run reason, branch, worktree path, run directory, prompt/task paths, stdout/stderr paths, result summary, events, and GitHub result links. |
| UC-ADMIN-03-S03 | P2 | `GET /runs/:runId` returns a clear not-found page for missing local runs. |
| UC-ADMIN-03-S04 | P1 | When the admin web production build exists, `GET /`, hashed static asset paths, and SPA routes such as `/runs/:runId` are served from `dist/admin-web` while `/api/*` routes keep returning API responses. |
