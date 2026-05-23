# UC-WORKER-06: Manage Local Daemon Lifecycle

> Grovie can run its local daemon in the foreground or as a detached local background process while keeping control state and logs inspectable on disk.

## Rules

| ID | Rule |
|----|------|
| R1 | Background daemon state and logs live under `~/.grovie/daemon`. |
| R2 | `daemon stop` validates the recorded process before sending a termination signal. |
| R3 | Daemon process logs stay separate from per-run stdout and stderr logs. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-06-S01 | P1 | `grovie daemon run` runs the daemon in the foreground using watched repositories or an explicit `--repo`. |
| UC-WORKER-06-S02 | P1 | `grovie daemon start` starts a detached background daemon, records pid and log paths, and refuses to start another live daemon. |
| UC-WORKER-06-S03 | P1 | `grovie daemon stop` terminates the recorded background daemon only when the pid still matches Grovie daemon state. |
| UC-WORKER-06-S04 | P1 | `grovie daemon status` reports running, stopped, or stale background daemon state with pid and log paths when available. |
| UC-WORKER-06-S05 | P1 | `grovie daemon logs` prints recent daemon stdout and stderr from `~/.grovie/daemon`. |
| UC-WORKER-06-S06 | P1 | `grovie daemon logs --stream stdout|stderr|combined` selects which daemon process logs to read without reading run logs. |
| UC-WORKER-06-S07 | P1 | `grovie daemon logs --follow` tails selected daemon process logs and reports a clear error when daemon log files are unavailable. |
