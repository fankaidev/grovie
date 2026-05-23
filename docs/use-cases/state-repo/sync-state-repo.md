# UC-STATE-001: Sync Optional State Repository

> Users can configure one private GitHub repository as remote Grovie state storage for observability and recovery support.

## Rules

| ID | Rule |
|----|------|
| R1 | The state repo is optional and must not be required for local execution. |
| R2 | The default state repo is private. |
| R3 | Synced metadata uses relative paths, not absolute local paths. |
| R4 | Remote redaction is best-effort and is not a security boundary. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-STATE-001-S01 | P0 | Initializing state without an existing repo creates or configures one private `grovie-state` repository for the installation. |
| UC-STATE-001-S02 | P0 | Initializing state for a user with multiple GitHub owners asks the user which owner should contain the state repo. |
| UC-STATE-001-S03 | P0 | A daemon with state sync configured writes machine, daemon, heartbeat, agent, issue, session, and run files under `~/.grovie/state-repo`. |
| UC-STATE-001-S04 | P0 | An active run sync tick commits one daemon batch of updated state approximately once per minute. |
| UC-STATE-001-S05 | P0 | A run completion triggers a final state sync for that run. |
| UC-STATE-001-S06 | P0 | A state sync push conflict pulls, rebases, and retries without failing the active run. |
| UC-STATE-001-S07 | P0 | A state sync failure marks local synced state as pending and retries later without failing the active run. |
| UC-STATE-001-S08 | P1 | Synced run bundles include run metadata, prompt, context snapshot, stdout, stderr, and summary after best-effort redaction. |
| UC-STATE-001-S09 | P1 | Synced files redact common token, key, secret, password, database URL, bearer token, GitHub token, and OpenAI key patterns before writing remote state. |
| UC-STATE-001-S10 | P1 | State repo heartbeat records daemon observability data but is not used as a real-time scheduling lock. |
