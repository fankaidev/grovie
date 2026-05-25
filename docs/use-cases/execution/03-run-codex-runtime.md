# UC-EXECUTION-03: Run Codex Runtime

> Grovie runs the configured agent through the Codex runtime with explicit handoff files, streamed logs, and cooperative cancellation.

## Rules

| ID | Rule |
|----|------|
| R1 | The MVP supports the `codex` runtime. |
| R2 | Trusted Grovie context is separated from untrusted GitHub issue content. |
| R3 | Local stdout and stderr logs are raw execution logs. |
| R4 | Current Codex runs use `danger-full-access` sandboxing until configurable agent runtime safety settings are implemented. |
| R5 | Configured local agent instructions are trusted local context and are included in the runtime handoff separately from GitHub issue content. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-EXECUTION-03-S01 | P0 | A daemon with an available Codex CLI records the runtime as available for an explicitly configured local agent. |
| UC-EXECUTION-03-S02 | P0 | A daemon without an available Codex CLI marks the runtime unavailable and does not start assigned runs for that agent. |
| UC-EXECUTION-03-S03 | P0 | A run starts Codex in the agent session worktree with `danger-full-access` sandboxing and a prompt that separates trusted Grovie context from issue body and comments. |
| UC-EXECUTION-03-S04 | P0 | A running Codex process streams stdout and stderr to local log files before the process exits. |
| UC-EXECUTION-03-S05 | P0 | A canceled run terminates the active Codex process and records a canceled run result. |
| UC-EXECUTION-03-S06 | P1 | A Codex process failure records exit status, stdout path, stderr path, and failure summary in run metadata. |
| UC-EXECUTION-03-S07 | P0 | Codex runs persist the concrete Codex runtime session id and resume runs use that id instead of an ambiguous latest session. |
| UC-EXECUTION-03-S08 | P1 | A run for a configured local agent includes that agent's custom instructions in the generated prompt and task handoff. |
