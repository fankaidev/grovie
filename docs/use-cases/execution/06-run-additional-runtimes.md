# UC-EXECUTION-06: Run Additional Local Runtimes

> Grovie can run explicitly selected local agent CLI runtimes behind the same runtime boundary used by Codex.

## Rules

| ID | Rule |
|----|------|
| R1 | Runtime selection is explicit and limited to supported local CLI adapters. |
| R2 | All runtimes report availability through the runtime boundary. |
| R3 | All runtimes write stdout, stderr, runtime events, and cancellation state through the same local run files. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-EXECUTION-06-S01 | P2 | `cc`, `pi`, `opencode`, and `hermes` adapters check CLI availability with `--version`. |
| UC-EXECUTION-06-S02 | P2 | A selected non-Codex runtime writes handoff files, stdout, stderr, and runtime events through the existing runtime boundary. |
| UC-EXECUTION-06-S03 | P2 | A selected non-Codex runtime can be canceled through the runtime monitor and records a canceled result. |
| UC-EXECUTION-06-S04 | P2 | Config validation accepts only the supported explicit runtime names. |
