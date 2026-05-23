# UC-RUN-001: Run One GitHub Issue

> Users can point Grovie at one GitHub issue from any directory and let a local agent work on it in an isolated run.

## Rules

| ID | Rule |
|----|------|
| R1 | The explicit issue reference determines the target repository. |
| R2 | A run is not started when another active Grovie claim owns the issue. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-001-S01 | P0 | A readable issue with no active claim runs Codex once, writes local artifacts, and posts a succeeded run comment. |
| UC-RUN-001-S02 | P0 | An issue with another active Grovie claim exits before Codex starts and leaves the existing claim in place. |
| UC-RUN-001-S03 | P0 | A run whose Codex process fails posts a failed run comment with the error and log location. |
| UC-RUN-001-S04 | P0 | A run whose Codex process succeeds but result publishing fails is reported as a failed run. |
| UC-RUN-001-S05 | P1 | A run canceled while Codex is active posts a canceled run comment instead of success or failure. |
| UC-RUN-001-S06 | P1 | A run that cannot prepare its worktree reports the preparation failure and keeps inspectable run artifacts. |
