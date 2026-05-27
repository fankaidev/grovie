# UC-ADMIN-01: Run Daemon-Managed Local Admin Console Server

> Grovie can expose an opt-in local-only admin console server through the daemon without changing GitHub as the control plane.

## Rules

| ID | Rule |
|----|------|
| R1 | The daemon-managed admin console is disabled by default and does not bind a port unless explicitly enabled. |
| R2 | The admin console binds to `127.0.0.1` by default and uses an explicitly configured non-empty host when set. |
| R3 | The admin console must fail clearly when its configured port is unavailable. |
| R4 | A long-running daemon keeps the admin console responsive while the daemon polls repositories or runs agents. |
| R5 | Grovie does not expose a standalone `grovie admin serve` command; the admin console is managed by daemon startup. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-01-S01 | P2 | Loading the default global config keeps the admin console disabled. |
| UC-ADMIN-01-S02 | P2 | Enabling `adminConsole.enabled` starts a local server bound to `127.0.0.1` on port `8765` by default. |
| UC-ADMIN-01-S03 | P2 | Setting `adminConsole.port` overrides the default port without silently choosing a random fallback. |
| UC-ADMIN-01-S04 | P2 | Starting the admin console when the configured port is unavailable fails clearly. |
| UC-ADMIN-01-S05 | P2 | Setting `adminConsole.host` overrides the default bind host, while empty host values are rejected. |
| UC-ADMIN-01-S06 | P2 | Starting the daemon with `adminConsole.enabled: false` does not bind the configured admin console web port. |
| UC-ADMIN-01-S07 | P0 | A long-running daemon serves admin console health checks from a separate worker thread so synchronous daemon polling cannot block `/api/health`. |
| UC-ADMIN-01-S08 | P1 | The top-level CLI help does not list `grovie admin`, and `grovie admin serve` is rejected as an unknown command. |
