# UC-STATE-REPO-01: Sync Optional State Repository

> Users can configure one private GitHub repository as remote Grovie state storage for observability and recovery support.

## Rules

| ID | Rule |
|----|------|
| R1 | The state repo is optional and must not be required for local execution. |
| R2 | The default state repo is private. |
| R3 | Synced metadata uses relative paths, not absolute local paths. |
| R4 | Remote redaction is best-effort and is not a security boundary. |
| R5 | GitHub issue content is not synced to the state repo; any needed issue input snapshots stay in local run state. |

## Setup

`grovie state init` configures the optional global `stateRepo` block. By default it creates or configures a private `grovie-state` repository for the authenticated user, uses branch `main`, writes the local checkout under `~/.grovie/state-repo`, and syncs on roughly one-minute daemon ticks plus final run completion. If the authenticated account can create repositories under multiple owners, non-interactive setup must pass `--owner` or `--repo`.

State repo contents are for remote observability and recovery support only. A sync failure writes a local pending marker and the next sync retries; active runs continue based on local state.

Remote state is a sanitized projection of local execution files. It may include machine, daemon, heartbeat, agent, session, run metadata, prompt, stdout, stderr, events, and summary files, but it must not copy `task.json`, issue bodies, issue comments, or current issue-content snapshots. Redaction handles common token, key, secret, password, database URL, bearer token, GitHub token, and OpenAI key patterns on a best-effort basis; users must not treat it as a security boundary.

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-STATE-REPO-01-S01 | P0 | Initializing state without an existing repo creates or configures one private `grovie-state` repository for the installation. |
| UC-STATE-REPO-01-S02 | P0 | Initializing state for a user with multiple GitHub owners asks the user which owner should contain the state repo. |
| UC-STATE-REPO-01-S03 | P0 | A daemon with state sync configured writes machine, daemon, heartbeat, agent, session, and run files under `~/.grovie/state-repo`. |
| UC-STATE-REPO-01-S04 | P0 | An active run sync tick commits one daemon batch of updated state approximately once per minute. |
| UC-STATE-REPO-01-S05 | P0 | A run completion triggers a final state sync for that run. |
| UC-STATE-REPO-01-S06 | P0 | A state sync push conflict pulls, rebases, and retries without failing the active run. |
| UC-STATE-REPO-01-S07 | P0 | A state sync failure marks local synced state as pending and retries later without failing the active run. |
| UC-STATE-REPO-01-S08 | P1 | Synced run bundles include run metadata, prompt, stdout, stderr, and summary after best-effort redaction, without copying GitHub issue body or comments. |
| UC-STATE-REPO-01-S09 | P1 | Synced files redact common token, key, secret, password, database URL, bearer token, GitHub token, and OpenAI key patterns before writing remote state. |
| UC-STATE-REPO-01-S10 | P1 | State repo heartbeat records daemon observability data but is not used as a real-time scheduling lock. |
