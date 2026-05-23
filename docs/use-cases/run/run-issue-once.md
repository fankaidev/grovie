# UC-RUN-001: Run One GitHub Issue

> Users can point Grovie at one GitHub issue from any directory and let a local agent work on it in an isolated run.

## Rules

| ID | Rule |
|----|------|
| R1 | The explicit issue reference determines the target repository. |
| R2 | A run is not started when another active Grovie claim owns the issue. |
| R3 | Every finished run leaves a visible GitHub issue comment and local run artifacts. |
| R4 | Runtime success can still become a failed run if result handling fails. |

## Scenarios

| ID | Priority | Scenario | Rules |
|----|----------|----------|-------|
| UC-RUN-001-S01 | P0 | Running a claimable issue prepares local state, starts Codex, and posts a succeeded run comment. | R1, R3 |
| UC-RUN-001-S02 | P0 | Running an issue that already has another active Grovie claim exits without starting Codex. | R2 |
| UC-RUN-001-S03 | P0 | A Codex failure posts a failed run comment that points to local logs. | R3 |
| UC-RUN-001-S04 | P0 | A successful Codex run whose result cannot be published is still reported as a failed run. | R4 |
| UC-RUN-001-S05 | P1 | A canceled async run posts a canceled run comment instead of a success or failure comment. | R3 |
| UC-RUN-001-S06 | P1 | A preparation failure still creates enough local run information for the user to inspect what failed. | R3 |
