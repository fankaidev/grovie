# UC-DAEMON-001: Process Queued Issues

> A Grovie daemon watches GitHub issues, starts local runs for eligible work, and avoids duplicate execution.

## Rules

| ID | Rule |
|----|------|
| R1 | The daemon only starts work for issues selected by its configured queue. |
| R2 | A visible active claim prevents duplicate execution. |
| R3 | Cancellation before runtime start prevents agent execution. |
| R4 | Cancellation during runtime is detected through heartbeat checks. |
| R5 | Stale claims can be reclaimed conservatively. |

## Scenarios

| ID | Priority | Scenario | Rules |
|----|----------|----------|-------|
| UC-DAEMON-001-S01 | P0 | One claimable queued issue is claimed, run once, and released with a visible result. | R1 |
| UC-DAEMON-001-S02 | P0 | An issue with another active Grovie claim is skipped without starting a run. | R2 |
| UC-DAEMON-001-S03 | P0 | A cancellation comment seen before runtime start cancels the claimed run before Codex starts. | R3 |
| UC-DAEMON-001-S04 | P0 | A cancellation comment seen during runtime terminates the active run and records cancellation. | R4 |
| UC-DAEMON-001-S05 | P1 | A stale visible claim can be reclaimed so the issue is not permanently stuck. | R5 |
| UC-DAEMON-001-S06 | P1 | With multiple watched repositories, the daemon checks them sequentially until it finds queued work. | R1 |
