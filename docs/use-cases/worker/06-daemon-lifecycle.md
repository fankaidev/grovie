# UC-WORKER-06: Manage Local Daemon Lifecycle

> Grovie can run its local daemon in the foreground or as a detached local background process while keeping control state and logs inspectable on disk.

## Rules

| ID | Rule |
|----|------|
| R1 | Background daemon state and logs live under `~/.grovie/daemon`. |
| R2 | `daemon stop` validates the recorded process before sending a termination signal. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-06-S01 | P1 | `grovie daemon run` runs the daemon in the foreground using watched repositories or an explicit `--repo`. |
| UC-WORKER-06-S02 | P1 | `grovie daemon start` starts a detached background daemon, records pid and log paths, and refuses to start another live daemon. |
| UC-WORKER-06-S03 | P1 | `grovie daemon stop` terminates the recorded background daemon only when the pid still matches Grovie daemon state. |
| UC-WORKER-06-S04 | P1 | `grovie daemon status` reports running, stopped, or stale background daemon state with pid and log paths when available. |
