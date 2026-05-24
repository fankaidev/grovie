# UC-ADMIN-01: Run Local Admin Console Server

> Grovie can expose an opt-in local-only admin console server without changing GitHub as the control plane.

## Rules

| ID | Rule |
|----|------|
| R1 | The admin console is disabled by default. |
| R2 | The admin console binds only to `127.0.0.1` for the MVP. |
| R3 | The admin console must fail clearly when its configured port is unavailable. |
| R4 | A disabled admin console is not bound by daemon startup. |
| R5 | A long-running daemon keeps the admin console responsive while the daemon polls repositories or runs agents. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-ADMIN-01-S01 | P2 | Loading the default global config keeps the admin console disabled. |
| UC-ADMIN-01-S02 | P2 | Enabling `adminConsole.enabled` starts a local server bound to `127.0.0.1` on port `8765` by default. |
| UC-ADMIN-01-S03 | P2 | Setting `adminConsole.port` overrides the default port without silently choosing a random fallback. |
| UC-ADMIN-01-S04 | P2 | Starting the admin console when the configured port is unavailable fails clearly. |
| UC-ADMIN-01-S05 | P2 | The admin console does not accept non-local bind hosts in config. |
| UC-ADMIN-01-S06 | P2 | Starting the daemon with `adminConsole.enabled: false` does not bind the configured admin console web port. |
| UC-ADMIN-01-S07 | P0 | A long-running daemon serves admin console health checks from a separate worker thread so synchronous daemon polling cannot block `/api/health`. |
