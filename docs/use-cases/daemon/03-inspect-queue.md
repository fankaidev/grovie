# UC-DAEMON-03: Keep Queue Internal

> Grovie keeps daemon queue inspection as internal scheduling behavior instead of exposing a separate user-facing queue command.

## Rules

| ID | Rule |
|----|------|
| R1 | The user-facing CLI does not expose a standalone queue inspection command. |
| R2 | Daemon scheduling still uses internal queue eligibility and priority ordering. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-03-S01 | P1 | The CLI does not expose a `grovie queue` command; daemon queue behavior is only exercised through daemon scheduling. |
