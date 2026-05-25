# UC-WORKER-01: Resolve Machine and Agent Identity

> Grovie gives every local daemon and agent a stable readable identity so GitHub labels, local state, and synced state can refer to the same executor.

## Rules

| ID | Rule |
|----|------|
| R1 | Slugs are lowercase and contain only `a-z`, `0-9`, and `-`. |
| R2 | Agent ids use `<agent-slug>@<machine-slug>`. |
| R3 | Local agents must be explicitly configured in global worker config. |
| R4 | Configured local agents expose runtime availability separately from their presence in config. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-01-S01 | P0 | A hostname such as `Fankai MacBook Pro.local` resolves to the machine id `fankai-macbook-pro-local`. |
| UC-WORKER-01-S02 | P0 | An agent name such as `Code Reviewer` on machine `fankai-mac` resolves to `code-reviewer@fankai-mac`. |
| UC-WORKER-01-S03 | P0 | Invalid slug characters collapse to single dashes and leading or trailing dashes are trimmed. |
| UC-WORKER-01-S04 | P0 | A configured agent name and local machine id resolve to a stable `agent@machine` id for labels and run state. |
| UC-WORKER-01-S05 | P1 | Agent config records runtime, instructions, model, args, and env key names without storing environment variable values. |
| UC-WORKER-01-S06 | P1 | `grovie doctor` reports each configured local agent with its runtime availability and fails when any configured agent runtime is unavailable. |
