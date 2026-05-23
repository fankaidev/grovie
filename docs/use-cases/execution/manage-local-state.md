# UC-LOCAL-001: Manage Local Execution State

> Grovie keeps daemon locks, sessions, runs, logs, and worktrees under the local Grovie root so execution can survive restarts and remain inspectable.

## Rules

| ID | Rule |
|----|------|
| R1 | Agent work never mutates the checkout where the user invoked Grovie. |
| R2 | Session cleanup can remove worktrees but must not delete run history. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-LOCAL-001-S01 | P0 | A first run for `(issue, agent)` creates a session directory, persistent worktree, branch, prompt, issue handoff, logs, and run metadata. |
| UC-LOCAL-001-S02 | P0 | A later run for the same `(issue, agent)` reuses the existing session worktree and branch. |
| UC-LOCAL-001-S03 | P0 | A run for a different agent on the same issue creates a separate session worktree and branch. |
| UC-LOCAL-001-S04 | P0 | A daemon restart reconstructs sessions, active-looking runs, handled cursors, and locks from local state. |
| UC-LOCAL-001-S05 | P0 | A run started from any directory prepares work under the Grovie root without changing the caller's checkout. |
| UC-LOCAL-001-S06 | P1 | A failed run preserves the session worktree so the next run can continue from the same context. |
| UC-LOCAL-001-S07 | P1 | Cleaning a completed session removes its worktree while keeping session and run history inspectable. |
