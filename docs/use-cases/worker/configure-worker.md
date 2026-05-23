# UC-CONFIG-001: Configure Global Worker

> Users configure one global Grovie installation that can watch multiple repositories and optionally sync state remotely.

## Rules

| ID | Rule |
|----|------|
| R1 | The daemon is global and does not depend on the current project directory. |
| R2 | Watched repositories are scheduling inputs, not an authorization allowlist. |
| R3 | Repo-local config can define project policy but not daemon identity. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-CONFIG-001-S01 | P0 | Adding `fankaidev/grovie` to global config makes the daemon watch that repository from any current directory. |
| UC-CONFIG-001-S02 | P0 | Removing `fankaidev/grovie` from global config stops future daemon polling for that repository. |
| UC-CONFIG-001-S03 | P0 | A daemon started outside any project checkout still loads watched repositories from the global config. |
| UC-CONFIG-001-S04 | P0 | A repo-local `.grovie.yml` can set safe project policy without changing the daemon's machine id or watched repository list. |
| UC-CONFIG-001-S05 | P1 | Global state repo config stores repo, branch, local path, and sync interval for optional remote state sync. |
| UC-CONFIG-001-S06 | P1 | Unsafe or unknown config shapes fail validation with a clear error. |
