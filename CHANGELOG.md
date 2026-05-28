# Changelog

## 0.2.1 - 2026-05-28

- Updated README with demo issue links.
- Bumped package version to 0.2.1.

## 0.2.0 - 2026-05-27

- Added an `npx @fankaidev/grovie@latest` Quick Start so users can run Grovie without installing it globally first.
- Added interactive `grovie init` for creating the global config from local runtimes and GitHub repository context.
- Added global daemon configuration through `~/.grovie/config.yml`, including local agents, watched repositories, queue labels, branch policy, trusted authors, daemon concurrency, admin console settings, and optional state repository sync.
- Added GitHub issue assignment with concrete local agent labels such as `agent:coder@machine`.
- Added background daemon execution through `grovie daemon start`, with status, logs, local locking, bounded concurrency, and polling from visible GitHub issue and pull request activity.
- Added persistent issue-agent sessions with reusable worktrees, handled cursors, run history, resumable runtime session refs, and recovery after daemon stop or crash.
- Added Codex, Claude Code, and Pi runtime adapters with agent instructions, optional model selection, environment allowlists, and `grovie doctor --verify-agents`.
- Added run-scoped task, prompt, result, comment, stdout, stderr, and event artifacts under `.grovie/runs/<runId>/`.
- Added safe GitHub publishing through generated branches, pull requests, issue comments, structured run results, and run summaries without default-branch pushes or force-pushes.
- Added local observability through `grovie status`, `grovie runs list`, `grovie runs show`, `grovie runs cleanup`, daemon logs, and the opt-in local admin console.
- Added optional private state repository sync for sanitized daemon, agent, session, run, log, and summary metadata.
- Added the Grovie Codex skill, BDD use-case docs, README Mermaid workflow diagram, and isolated smoke validation guidance.
