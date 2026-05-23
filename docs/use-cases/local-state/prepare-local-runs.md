# UC-LOCAL-001: Prepare Local Run State

> Grovie keeps agent work isolated under the local Grovie root so a run can be inspected without modifying the caller's checkout.

## Rules

| ID | Rule |
|----|------|
| R1 | Result branches are deterministic per issue. |
| R2 | Local run directories and worktrees are attempt-specific. |
| R3 | Run artifacts are created before agent execution and preserved for inspection. |
| R4 | Cleanup can remove worktrees but must not delete run logs. |

## Scenarios

| ID | Priority | Scenario | Rules |
|----|----------|----------|-------|
| UC-LOCAL-001-S01 | P0 | Preparing a run creates a local repo cache, isolated worktree, prompt, issue handoff, logs, and event stream. | R2, R3 |
| UC-LOCAL-001-S02 | P0 | Re-running the same issue uses a new local attempt while keeping the same deterministic result branch. | R1, R2 |
| UC-LOCAL-001-S03 | P0 | Preparing a run never mutates the checkout where the user invoked Grovie. | R2 |
| UC-LOCAL-001-S04 | P1 | Cleaning up a successful run removes the worktree while keeping logs and events available. | R4 |
| UC-LOCAL-001-S05 | P1 | A failed worktree preparation still leaves run artifacts that explain the failure location. | R3 |
