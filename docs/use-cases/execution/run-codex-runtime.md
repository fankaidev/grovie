# UC-RUNTIME-001: Run Codex Runtime

> Grovie runs the configured agent through the Codex runtime with explicit handoff files, streamed logs, and cooperative cancellation.

## Rules

| ID | Rule |
|----|------|
| R1 | The MVP supports the `codex` runtime. |
| R2 | Trusted Grovie context is separated from untrusted GitHub issue content. |
| R3 | Local stdout and stderr logs are raw execution logs. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUNTIME-001-S01 | P0 | A daemon with an available Codex CLI records the runtime as available for the default local agent. |
| UC-RUNTIME-001-S02 | P0 | A daemon without an available Codex CLI marks the runtime unavailable and does not start assigned runs for that agent. |
| UC-RUNTIME-001-S03 | P0 | A run starts Codex in the agent session worktree with a prompt that separates trusted Grovie context from issue body and comments. |
| UC-RUNTIME-001-S04 | P0 | A running Codex process streams stdout and stderr to local log files before the process exits. |
| UC-RUNTIME-001-S05 | P0 | A canceled run terminates the active Codex process and records a canceled run result. |
| UC-RUNTIME-001-S06 | P1 | A Codex process failure records exit status, stdout path, stderr path, and failure summary in run metadata. |
