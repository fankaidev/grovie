# UC-EXECUTION-04: Manage Local Execution State

> Grovie keeps daemon locks, sessions, runs, logs, and worktrees under the local Grovie root so execution can survive restarts and remain inspectable.

## Rules

| ID | Rule |
|----|------|
| R1 | Agent work never mutates the checkout where the user invoked Grovie. |
| R2 | Session cleanup can remove worktrees but must not delete run history. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-EXECUTION-04-S01 | P0 | A first run for `(issue, agent)` creates a session directory, persistent worktree, branch, prompt, issue handoff, logs, and run metadata. |
| UC-EXECUTION-04-S02 | P0 | A later run for the same `(issue, agent)` reuses the existing session worktree and branch. |
| UC-EXECUTION-04-S03 | P0 | A run for a different agent on the same issue creates a separate session worktree and branch. |
| UC-EXECUTION-04-S04 | P0 | A daemon restart reconstructs sessions, active-looking runs, handled cursors, and locks from local state. |
| UC-EXECUTION-04-S05 | P0 | A run started from any directory prepares work under the Grovie root without changing the caller's checkout. |
| UC-EXECUTION-04-S06 | P1 | A failed run preserves the session worktree so the next run can continue from the same context. |
| UC-EXECUTION-04-S07 | P1 | Cleaning a completed session removes its worktree while keeping session and run history inspectable. |
| UC-EXECUTION-04-S08 | P1 | `grovie runs cleanup --dry-run` shows local cleanup actions without deleting worktrees, sessions, or run logs. |
| UC-EXECUTION-04-S09 | P1 | Default cleanup skips failed, canceled, active, and stale session worktrees so inspection and continuation remain possible. |
| UC-EXECUTION-04-S10 | P2 | `grovie runs cleanup --logs` removes terminal run directories only when logs are explicitly included. |
