# Changelog

All notable user-facing changes to Grovie are recorded here.

## 0.2.0 - 2026-05-27

### Added

- Added an `npx @fankaidev/grovie@latest` Quick Start so users can run Grovie without installing it globally first.
- Added interactive `grovie init` for creating the global config from detected local runtimes and GitHub repository context.
- Added global daemon configuration through `~/.grovie/config.yml`, including local agents, watched repositories, queue labels, branch policy, trusted authors, daemon concurrency, optional admin console settings, and optional state repository sync.
- Added local agent identities in the form `<agent>@<machine>` and GitHub assignment labels through `grovie issue assign` and `grovie issue unassign`.
- Added daemon-managed GitHub issue polling that starts work from visible GitHub activity: labels, issue comments, related pull request activity, reviews, checks, and mergeability changes.
- Added persistent issue-agent sessions with stable worktrees, handled cursors, run history, logs, resumable runtime session references, and recovery after daemon stop or crash.
- Added bounded daemon concurrency so multiple local agents can run in parallel while preserving per-issue-agent execution locks.
- Added runtime adapters for Codex, Claude Code, and Pi, including runtime availability checks, configured agent instructions, optional model selection, and explicit environment variable allowlists.
- Added `grovie doctor --verify-agents` for optional real runtime verification with redacted output.
- Added run-scoped handoff artifacts under `.grovie/runs/<runId>/`, including structured task context, prompt files, result files, issue comment artifacts, stdout, stderr, and events.
- Added structured run results for no-op, comment, code-change, review, handoff, and request-human outcomes.
- Added safe GitHub publishing through generated branches, pull requests, issue comments, and run summaries without pushing directly to the default branch or force-pushing existing remote work.
- Added follow-up execution from visible GitHub issue activity instead of hidden local request files.
- Added cancellation through local cancellation requests, issue comments, and cancel labels.
- Added `grovie runs list`, `grovie runs show`, and `grovie runs cleanup` for inspecting and cleaning local run state.
- Added `grovie status`, `grovie daemon status`, and `grovie daemon logs` for local daemon and run observability.
- Added an opt-in local admin console owned by the daemon, with local APIs and React views for daemon health, config, watched repositories, recent activity, run details, run logs, transcripts, and safe run cancellation.
- Added optional private state repository sync for sanitized local daemon, agent, session, run, log, and summary metadata.
- Added a Grovie Codex skill under `skills/grovie/`.
- Added BDD-style use-case documentation under `docs/use-cases/` and a README Mermaid flow diagram for the GitHub-to-local-daemon workflow.
- Added isolated smoke validation guidance using a temporary `HOME`, real GitHub auth, and fake agent runtimes.

### Changed

- Simplified Grovie around GitHub as the control plane and the local machine as the executor.
- Moved repository policy into global `watchedRepositories` entries and stopped using repo-local `.grovie.yml` config.
- Made daemon execution background-first through `grovie daemon start`, with daemon state and logs stored under `~/.grovie/daemon`.
- Minimized continuation prompts while keeping complete structured context available in local task files.
- Scoped current run artifacts to run-specific paths so stale `.grovie` files from earlier runs are ignored.
- Improved queue polling with repository event caching, ETag handling, fallback scans, related pull request context, and clearer skipped-work activity.
- Improved run comments and summaries to include concise status, reason, result links, branch or pull request information, and no-change handling.
- Improved CLI argument validation so unknown options, duplicate options, and extra positional arguments fail clearly.
- Reworked README, command help, and use cases around the current smaller CLI surface.

### Removed

- Removed the top-level `grovie run` command and the hidden local request-file queue.
- Removed user-facing `grovie watch` and `grovie queue` commands; watched repositories are edited in global config and queue inspection remains internal daemon behavior.
- Removed standalone `grovie admin serve`; the admin console is managed by daemon startup.
- Removed foreground `grovie daemon [--repo ...] [--once]`; daemon execution is started through `grovie daemon start`.
- Removed `grovie daemon service` launchd/systemd service file generation.
- Removed implicit default local agents; local agents must be explicitly configured.
- Removed legacy runtime names such as `cc`, `opencode`, and `hermes`.

## 0.1.0

- Initial public MVP release of Grovie as a GitHub-native local runner for coding agents.
