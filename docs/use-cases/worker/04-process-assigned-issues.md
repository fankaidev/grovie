# UC-WORKER-04: Process Assigned Issues

> A Grovie daemon watches configured repositories, starts runs for local assigned agents, and keeps execution serialized per issue and agent.

## Rules

| ID | Rule |
|----|------|
| R1 | A machine should have at most one active daemon. |
| R2 | Execution locks are local and keyed by `(issue, agent)`. |
| R3 | Different agents can work on the same issue independently. |
| R4 | Before polling a watched repository, the daemon resolves that repository's `.grovie.yml` from the bare cache on the remote default branch; the issue worktree is prepared later with the same resolved policy. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-04-S01 | P0 | Starting a daemon when a live daemon lock already exists refuses to start a second daemon for the same machine. |
| UC-WORKER-04-S02 | P0 | Starting a daemon with a stale daemon lock recovers the lock and continues from persisted local state. |
| UC-WORKER-04-S03 | P0 | A daemon cycle with one issue assigned to a local agent and new unhandled activity creates one run for that `(issue, agent)`. |
| UC-WORKER-04-S04 | P0 | A daemon cycle skips an assigned issue when the agent's handled cursor already covers the latest issue activity. |
| UC-WORKER-04-S05 | P0 | A daemon cycle skips an assigned issue when a local execution lock already exists for the same `(issue, agent)`. |
| UC-WORKER-04-S06 | P0 | An issue assigned to two local agents can create independent runs for both agents. |
| UC-WORKER-04-S07 | P1 | A reviewer agent assigned before a PR exists can still run and decide from context that no action is needed. |
| UC-WORKER-04-S08 | P1 | A daemon watching multiple repositories checks each configured repository for assigned local agents. |
| UC-WORKER-04-S09 | P1 | Runnable assigned issues are picked by `priority:p0`, then `priority:p1`, then `priority:p2`, then no priority label, with older activity first within the same priority. |
| UC-WORKER-04-S10 | P1 | A skipped high-priority issue does not block a lower-priority runnable assigned issue. |
| UC-WORKER-04-S11 | P1 | A daemon cycle with skipped assigned issues reports skipped issue references and reasons instead of only saying no queued issues were found. |
| UC-WORKER-04-S12 | P1 | A watched repository's `.grovie.yml` supplies daemon policy defaults such as `runtime.default`, queue label, branch prefix, pull request behavior, comments mode, and safety policy for runs in that repository. |
| UC-WORKER-04-S13 | P1 | An invalid watched repository `.grovie.yml` prevents runs for that repository with a clear error while the daemon can continue checking unrelated watched repositories. |
| UC-WORKER-04-S14 | P0 | A daemon cycle skips an issue assigned to an agent id that matches the machine but is not configured locally. |
