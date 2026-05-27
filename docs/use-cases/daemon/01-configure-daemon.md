# UC-DAEMON-01: Configure Local Daemon

> Users configure one global Grovie installation that can watch multiple repositories and optionally sync state remotely.

## Rules

| ID | Rule |
|----|------|
| R1 | The daemon is global and does not depend on the current project directory. |
| R2 | Watched repositories are scheduling inputs, not an authorization allowlist. |
| R3 | Repository policy lives inside global `watchedRepositories` entries; Grovie does not read repo-local config. |
| R4 | Local agents are explicit global config; Grovie does not create an implicit default agent. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-01-S01 | P0 | Adding `fankaidev/grovie` to global config makes the daemon watch that repository from any current directory. |
| UC-DAEMON-01-S02 | P0 | Removing `fankaidev/grovie` from global config stops future daemon polling for that repository. |
| UC-DAEMON-01-S03 | P0 | A daemon started outside any project checkout still loads watched repositories from the global config. |
| UC-DAEMON-01-S04 | P0 | A `watchedRepositories` entry can set safe repository policy for that repository's daemon runs without changing the daemon's machine id. |
| UC-DAEMON-01-S05 | P1 | Global state repo config stores repo, branch, and sync interval for optional remote state sync. |
| UC-DAEMON-01-S06 | P1 | Unsafe or unknown config shapes fail validation with a clear error. |
| UC-DAEMON-01-S07 | P0 | A daemon started with no configured local agents exits clearly before polling work. |
| UC-DAEMON-01-S08 | P1 | Global daemon config accepts `maxConcurrentRuns` as a positive integer and defaults it to `3` when omitted. |
| UC-DAEMON-01-S09 | P1 | The CLI does not expose a `grovie watch` command for mutating `watchedRepositories`; users edit the global config directly. |
