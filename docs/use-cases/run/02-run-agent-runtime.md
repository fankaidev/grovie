# UC-RUN-02: Run Agent Runtime

> Grovie runs the configured agent through its selected runtime with explicit handoff files, streamed logs, and cooperative cancellation. Codex is the baseline runtime.

## Rules

| ID | Rule |
|----|------|
| R1 | Trusted Grovie context is separated from untrusted GitHub issue content. |
| R2 | Local stdout and stderr logs are raw execution logs. |
| R3 | Configured local agent instructions are trusted local context and are included in the runtime handoff separately from GitHub issue content. |
| R4 | Runtime child processes receive only a small baseline environment plus variables explicitly named by the configured agent `envKeys` allowlist. |
| R5 | A configured local agent `model`, when present, selects the primary model for that runtime invocation. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-02-S01 | P0 | A daemon with an available Codex CLI records the runtime as available for an explicitly configured local agent. |
| UC-RUN-02-S02 | P0 | A daemon without an available Codex CLI marks the runtime unavailable and does not start assigned runs for that agent. |
| UC-RUN-02-S03 | P0 | A run starts Codex in the agent session worktree with `danger-full-access` sandboxing and a prompt that separates trusted Grovie context from issue body and comments. |
| UC-RUN-02-S04 | P0 | A running Codex process streams stdout and stderr to local log files before the process exits. |
| UC-RUN-02-S05 | P0 | A canceled run terminates the active Codex process and records a canceled run result. |
| UC-RUN-02-S06 | P1 | A Codex process failure records exit status, stdout path, stderr path, and failure summary in run metadata. |
| UC-RUN-02-S07 | P0 | Codex runs persist the concrete Codex runtime session id and resume runs use that id instead of an ambiguous latest session. |
| UC-RUN-02-S08 | P1 | A run for a configured local agent includes that agent's custom instructions in the generated prompt and task handoff. |
| UC-RUN-02-S09 | P1 | A run handoff includes trigger context with source, activity timestamp, activity fingerprint, previous handled cursor when available, and daemon trigger metadata when applicable. |
| UC-RUN-02-S10 | P1 | A run for a configured local agent passes only baseline environment variables and that agent's configured `envKeys` values to the runtime child process. |
| UC-RUN-02-S11 | P1 | A run for a configured local agent passes that agent's configured primary `model` to the runtime child process. |
