# UC-DAEMON-03: Inspect Assigned Issue Queue

> Grovie shows which assigned GitHub issues the local daemon would consider next without claiming work or mutating GitHub state.

## Rules

| ID | Rule |
|----|------|
| R1 | Queue inspection is read-only: it must not create claim comments, enqueue runs, or start runtimes. |
| R2 | Queue inspection uses the same local eligibility and priority ordering as daemon picking. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-03-S01 | P1 | `grovie queue list` reads global watched repositories and shows assigned issues in daemon pick order. |
| UC-DAEMON-03-S02 | P1 | `grovie queue list --repo owner/repo` inspects one repository without reading watched repositories. |
| UC-DAEMON-03-S03 | P1 | Queue output marks runnable local assignments with pick order, agent id, priority, and latest activity timestamp. |
| UC-DAEMON-03-S04 | P1 | Queue output marks skipped assignments with clear reasons for another machine, no unhandled activity, active local execution lock, or cancellation. |
| UC-DAEMON-03-S05 | P1 | Queue inspection does not mutate GitHub state, write local request files, or start runtimes. |
| UC-DAEMON-03-S06 | P1 | `grovie queue list --json` prints the same queue inspection result as structured JSON. |
| UC-DAEMON-03-S07 | P1 | Queue inspection skips machine-local agent labels that are not configured in global local agent config. |
| UC-DAEMON-03-S08 | P1 | `grovie queue list --fast` and `grovie queue list --no-pr-context` skip related pull request, review, check, and diff context for a bounded issue-only inspection. |
| UC-DAEMON-03-S09 | P1 | `grovie queue list --timeout 15s` applies a timeout to underlying `gh` calls, and invalid timeout values fail before queue inspection starts. |
