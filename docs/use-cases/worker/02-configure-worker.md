# UC-WORKER-02: Configure Global Worker

> Users configure one global Grovie installation that can watch multiple repositories and optionally sync state remotely.

## Rules

| ID | Rule |
|----|------|
| R1 | The daemon is global and does not depend on the current project directory. |
| R2 | Watched repositories are scheduling inputs, not an authorization allowlist. |
| R3 | Repo-local config can define project policy but not daemon identity or the watched repository list. |
| R4 | Local agents are explicit global config; Grovie does not create an implicit default agent. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-02-S01 | P0 | Adding `fankaidev/grovie` to global config makes the daemon watch that repository from any current directory. |
| UC-WORKER-02-S02 | P0 | Removing `fankaidev/grovie` from global config stops future daemon polling for that repository. |
| UC-WORKER-02-S03 | P0 | A daemon started outside any project checkout still loads watched repositories from the global config. |
| UC-WORKER-02-S04 | P0 | A repo-local `.grovie.yml` can set safe project policy for that repository's daemon runs without changing the daemon's machine id or watched repository list. |
| UC-WORKER-02-S05 | P1 | Global state repo config stores repo, branch, local path, and sync interval for optional remote state sync. |
| UC-WORKER-02-S06 | P1 | Unsafe or unknown config shapes fail validation with a clear error. |
| UC-WORKER-02-S07 | P0 | A daemon started with no configured local agents exits clearly before polling work. |
