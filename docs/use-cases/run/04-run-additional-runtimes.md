# UC-RUN-04: Run Additional Local Runtimes

> Grovie can run explicitly selected local agent CLI runtimes behind the same runtime boundary used by Codex.

## Rules

| ID | Rule |
|----|------|
| R1 | Runtime selection is explicit and limited to supported local CLI adapters. |
| R2 | All runtimes write stdout, stderr, runtime events, and cancellation state through the same local run files. |
| R3 | All runtime child processes receive the same baseline-plus-`envKeys` allowlisted environment behavior. |
| R4 | Runtime adapters map a configured primary `model` to the runtime CLI's model option when that runtime supports it. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-RUN-04-S01 | P2 | `codex`, `claude-code`, and `pi` adapters report CLI availability through the runtime boundary. |
| UC-RUN-04-S02 | P2 | A selected non-Codex runtime writes handoff files, stdout, stderr, and runtime events through the existing runtime boundary. |
| UC-RUN-04-S03 | P2 | A selected non-Codex runtime can be canceled through the runtime monitor and records a canceled result. |
| UC-RUN-04-S04 | P2 | Config validation accepts only `codex`, `claude-code`, and `pi`, and rejects retired runtime names such as `cc`, `opencode`, and `hermes`. |
| UC-RUN-04-S05 | P1 | Each supported runtime can resume from a persisted runtime session reference across follow-up issue-agent runs. |
| UC-RUN-04-S06 | P1 | Claude Code and Pi receive a configured primary `model` through their runtime CLI model option. |
| UC-RUN-04-S07 | P1 | Pi runtime runs use Pi's print mode and do not pass an unsupported standalone dash argument. |
