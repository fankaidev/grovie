# UC-DAEMON-04: Manage Local Daemon Lifecycle

> Grovie can run its local daemon in the foreground or as a detached local background process while keeping control state and logs inspectable on disk.

## Rules

| ID | Rule |
|----|------|
| R1 | `daemon stop` validates the recorded process before sending a termination signal. |
| R2 | Daemon process logs stay separate from per-run stdout and stderr logs. |
| R3 | When the admin console is enabled, the daemon process owns the admin console server lifecycle. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-04-S01 | P1 | `grovie daemon run` runs the daemon in the foreground using watched repositories or an explicit `--repo`. |
| UC-DAEMON-04-S02 | P1 | `grovie daemon start` starts a detached background daemon, records pid and log paths, and refuses to start another live daemon. |
| UC-DAEMON-04-S03 | P1 | `grovie daemon stop` terminates the recorded background daemon only when the pid still matches Grovie daemon state. |
| UC-DAEMON-04-S04 | P1 | `grovie daemon status` reports running, stopped, or stale background daemon state with pid and log paths when available. |
| UC-DAEMON-04-S05 | P1 | `grovie daemon logs` prints recent daemon stdout and stderr from `~/.grovie/daemon`. |
| UC-DAEMON-04-S06 | P1 | `grovie daemon logs --stream stdout|stderr|combined` selects which daemon process logs to read without reading run logs. |
| UC-DAEMON-04-S07 | P1 | `grovie daemon logs --follow` tails selected daemon process logs and reports a clear error when daemon log files are unavailable. |
| UC-DAEMON-04-S08 | P1 | `grovie status` summarizes daemon state, configured agent availability, watched repositories, useful local paths, active runs, and recent failures. |
| UC-DAEMON-04-S09 | P2 | `grovie daemon service install --platform launchd` writes a Grovie-managed user LaunchAgent file that runs `grovie daemon run` and logs under `~/.grovie/daemon`. |
| UC-DAEMON-04-S10 | P2 | `grovie daemon service install --platform systemd` writes a Grovie-managed user systemd service file that runs `grovie daemon run` and logs under `~/.grovie/daemon`. |
| UC-DAEMON-04-S11 | P2 | `grovie daemon service uninstall` removes only generated Grovie-managed user service files without stopping or deleting local daemon state. |
| UC-DAEMON-04-S12 | P2 | `grovie daemon service path` reports the platform-specific user service file path without creating, starting, or deleting service files. |
| UC-DAEMON-04-S13 | P2 | `grovie daemon stop --force` passes a force stop request to the daemon lifecycle for crash recovery workflows. |
| UC-DAEMON-04-S14 | P1 | `grovie daemon run` starts the enabled admin console in the same daemon process and makes `GET /api/health` available at the configured local URL. |
| UC-DAEMON-04-S15 | P1 | Stopping the daemon also stops the admin console server owned by that daemon process. |
| UC-DAEMON-04-S16 | P1 | `grovie status` reports rejected local runs as rejected recent failures. |
