# UC-LOCAL-001: Prepare Local Run State

> Grovie keeps agent work isolated under the local Grovie root so a run can be inspected without modifying the caller's checkout.

## Rules

| ID | Rule |
|----|------|
| R1 | Agent work never mutates the checkout where the user invoked Grovie. |
| R2 | Cleanup can remove worktrees but must not delete run logs. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-LOCAL-001-S01 | P0 | A first run for a repository creates a local repo cache, isolated worktree, prompt, issue handoff, logs, and event stream. |
| UC-LOCAL-001-S02 | P0 | A repeated run for the same issue creates a new local attempt while reusing the deterministic result branch name. |
| UC-LOCAL-001-S03 | P0 | A run started from an existing checkout prepares work under the Grovie root without changing the caller's checkout. |
| UC-LOCAL-001-S04 | P1 | A successful run cleanup removes the attempt worktree while keeping its logs and events available. |
| UC-LOCAL-001-S05 | P1 | A worktree preparation failure still leaves run metadata and error information under the run directory. |
