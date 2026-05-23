# UC-WORKER-01: Resolve Machine and Agent Identity

> Grovie gives every local daemon and agent a stable readable identity so GitHub labels, local state, and synced state can refer to the same executor.

## Rules

| ID | Rule |
|----|------|
| R1 | Slugs are lowercase and contain only `a-z`, `0-9`, and `-`. |
| R2 | Agent ids use `<agent-slug>@<machine-slug>`. |
| R3 | The MVP exposes a default Codex-backed agent for each machine. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-WORKER-01-S01 | P0 | A hostname such as `Fankai MacBook Pro.local` resolves to the machine id `fankai-macbook-pro-local`. |
| UC-WORKER-01-S02 | P0 | An agent name such as `Code Reviewer` on machine `fankai-mac` resolves to `code-reviewer@fankai-mac`. |
| UC-WORKER-01-S03 | P0 | Invalid slug characters collapse to single dashes and leading or trailing dashes are trimmed. |
| UC-WORKER-01-S04 | P0 | A daemon with no custom runtime config exposes `default@<machine-id>` using the `codex` runtime. |
| UC-WORKER-01-S05 | P1 | Agent registry metadata records configuration such as runtime, instructions, model, args, and env key names without storing environment variable values. |
