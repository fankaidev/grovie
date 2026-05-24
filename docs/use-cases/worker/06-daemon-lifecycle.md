# UC-WORKER-06: Manage Local Daemon Lifecycle

> Grovie can run its local daemon in the foreground or as a detached local background process while keeping control state and logs inspectable on disk.

## Rules

| ID | Rule |
|----|------|
| R1 | Background daemon state and logs live under `~/.grovie/daemon`. |
| R2 | `daemon stop` validates the recorded process before sending a termination signal. |
| R3 | Daemon process logs stay separate from per-run stdout and stderr logs. |
| R4 | When the admin console is enabled, the daemon process owns the admin console server lifecycle. |

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
| UC-WORKER-06-S08 | P1 | `grovie status` summarizes daemon state, watched repositories, useful local paths, active runs, and recent failures. |
| UC-WORKER-06-S09 | P2 | `grovie daemon service install --platform launchd` writes a Grovie-managed user LaunchAgent file that runs `grovie daemon run` and logs under `~/.grovie/daemon`. |
| UC-WORKER-06-S10 | P2 | `grovie daemon service install --platform systemd` writes a Grovie-managed user systemd service file that runs `grovie daemon run` and logs under `~/.grovie/daemon`. |
| UC-WORKER-06-S11 | P2 | `grovie daemon service uninstall` removes only generated Grovie-managed user service files without stopping or deleting local daemon state. |
| UC-WORKER-06-S12 | P2 | `grovie daemon service path` reports the platform-specific user service file path without creating, starting, or deleting service files. |
| UC-WORKER-06-S13 | P1 | `grovie daemon run` starts the enabled admin console in the same daemon process and makes `GET /api/health` available at the configured local URL. |
| UC-WORKER-06-S14 | P1 | Stopping the daemon also stops the admin console server owned by that daemon process. |
