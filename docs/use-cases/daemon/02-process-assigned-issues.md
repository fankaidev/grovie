# UC-DAEMON-02: Process Assigned Issues

> A Grovie daemon watches configured repositories, starts runs for local assigned agents, and keeps execution serialized per issue and agent.

## Rules

| ID | Rule |
|----|------|
| R1 | A machine should have at most one active daemon. |
| R2 | Execution locks are local and keyed by `(issue, agent)`. |
| R3 | Different agents can work on the same issue independently. |
| R4 | Fresh issue and pull request reads remain the source of truth before starting work. |
| R5 | Automatic queue runs require the issue creator to be trusted; watched repository `trust.trustedAuthors` supplies the trusted list, and the authenticated `gh` user is the default when no trusted authors are configured. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-02-S01 | P0 | Starting a daemon when a live daemon lock already exists refuses to start a second daemon for the same machine. |
| UC-DAEMON-02-S02 | P0 | Starting a daemon with a stale daemon lock recovers the lock and continues from persisted local state. |
| UC-DAEMON-02-S03 | P0 | A daemon cycle with one issue assigned to a local agent and new unhandled activity creates one run for that `(issue, agent)`. |
| UC-DAEMON-02-S04 | P0 | A daemon cycle skips an assigned issue when the agent's handled cursor already covers the latest issue activity. |
| UC-DAEMON-02-S05 | P0 | A daemon cycle skips an assigned issue when a local execution lock already exists for the same `(issue, agent)`. |
| UC-DAEMON-02-S06 | P0 | An issue assigned to two local agents can create independent runs for both agents. |
| UC-DAEMON-02-S07 | P1 | A reviewer agent assigned before a PR exists can still run and decide from context that no action is needed. |
| UC-DAEMON-02-S08 | P1 | A daemon watching multiple repositories checks each configured repository for assigned local agents. |
| UC-DAEMON-02-S09 | P1 | Runnable assigned issues are picked by `priority:p0`, then `priority:p1`, then `priority:p2`, then no priority label, with older activity first within the same priority. |
| UC-DAEMON-02-S10 | P1 | A skipped high-priority issue does not block a lower-priority runnable assigned issue. |
| UC-DAEMON-02-S11 | P1 | A daemon cycle with skipped assigned issues reports skipped issue references and reasons instead of only saying no queued issues were found. |
| UC-DAEMON-02-S12 | P1 | A watched repository entry supplies daemon policy defaults such as queue label, branch prefix, and trust policy for runs in that repository. |
| UC-DAEMON-02-S13 | P1 | An invalid watched repository entry fails global config validation with a clear error before daemon polling starts. |
| UC-DAEMON-02-S14 | P0 | A daemon cycle skips an issue assigned to an agent id that matches the machine but is not configured locally. |
| UC-DAEMON-02-S15 | P1 | A long-running daemon cycle reads repository events, skips queue inspection when no relevant events changed, resolves pull request events to related issues through GitHub with a local cache, and periodically falls back to a full queue scan. |
| UC-DAEMON-02-S16 | P1 | A daemon cycle reruns a handled issue when a linked open pull request's merge state changes to `DIRTY` or otherwise requires branch update work, and records daemon activity explaining the mergeability trigger. |
| UC-DAEMON-02-S17 | P1 | A daemon cycle skips automatic queue runs whose issue creator is not trusted, while configured trusted authors can allow creators other than the authenticated `gh` user. |
| UC-DAEMON-02-S18 | P1 | A long-running daemon obeys GitHub repository event `X-Poll-Interval` values, sends stored `ETag` values through `If-None-Match`, and treats `304 Not Modified` as unchanged repository events. |
| UC-DAEMON-02-S19 | P1 | A daemon silently skips and advances handled state when an agent's only new effective activity is that same agent's own visible output, but still runs when the delta includes another agent's output. |
| UC-DAEMON-02-S20 | P1 | A daemon cycle fans out runnable work to multiple local agents up to the global `maxConcurrentRuns` limit while preserving per `(issue, agent)` execution locks. |
