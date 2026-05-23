# UC-DAEMON-001: Process Queued Issues

> A Grovie daemon watches GitHub issues, starts local runs for eligible work, and avoids duplicate execution.

## Rules

| ID | Rule |
|----|------|
| R1 | The daemon only starts work for issues selected by its configured queue. |
| R2 | A visible active claim prevents duplicate execution. |
| R3 | Cancellation prevents a run from being reported as successful. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-001-S01 | P0 | A daemon cycle with one claimable queued issue claims it, runs it once, and releases it with a visible result. |
| UC-DAEMON-001-S02 | P0 | A daemon cycle that sees another active Grovie claim skips that issue and starts no run. |
| UC-DAEMON-001-S03 | P0 | A claimed issue with a cancellation comment before runtime start is canceled before Codex starts. |
| UC-DAEMON-001-S04 | P0 | A running issue with a new cancellation comment terminates the active Codex run and records cancellation. |
| UC-DAEMON-001-S05 | P1 | A queued issue with a stale visible claim can be reclaimed and run by the current daemon. |
| UC-DAEMON-001-S06 | P1 | A daemon cycle with multiple watched repositories checks them sequentially until it finds queued work. |
