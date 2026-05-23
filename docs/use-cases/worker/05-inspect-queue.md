# UC-WORKER-05: Inspect Assigned Issue Queue

> Grovie shows which assigned GitHub issues the local daemon would consider next without claiming work or mutating GitHub state.

## Rules

| ID | Rule |
|----|------|
| R1 | Queue inspection is read-only: it must not create claim comments, enqueue runs, or start runtimes. |
| R2 | Queue inspection uses the same local eligibility and priority ordering as daemon picking. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-05-S01 | P1 | `grovie queue list` reads global watched repositories and shows assigned issues in daemon pick order. |
| UC-WORKER-05-S02 | P1 | `grovie queue list --repo owner/repo` inspects one repository without reading watched repositories. |
| UC-WORKER-05-S03 | P1 | Queue output marks runnable local assignments with pick order, agent id, priority, and latest activity timestamp. |
| UC-WORKER-05-S04 | P1 | Queue output marks skipped assignments with clear reasons for another machine, no unhandled activity, active local execution lock, or cancellation. |
| UC-WORKER-05-S05 | P1 | Queue inspection does not mutate GitHub state or enqueue local run requests. |
| UC-WORKER-05-S06 | P1 | `grovie queue list --json` prints the same queue inspection result as structured JSON. |
