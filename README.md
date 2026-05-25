# Grovie

[![CI](https://github.com/fankaidev/grovie/actions/workflows/ci.yml/badge.svg)](https://github.com/fankaidev/grovie/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40fankaidev%2Fgrovie.svg)](https://www.npmjs.com/package/@fankaidev/grovie)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Grovie lets you run coding agents from GitHub issues on your own machine.

Label an issue, let a local daemon pick it up, and get back a branch, pull request, logs, and reviewable GitHub comments without running a hosted agent platform. GitHub stays the control plane for issues, labels, comments, branches, pull requests, reviews, and CI; your local machine stays the executor for agents, worktrees, credentials, and logs.

```sh
npm install --global @fankaidev/grovie
gh auth login
grovie doctor
grovie daemon start
grovie run owner/repo#123 --agent codex
```

## Why Grovie?

- No hosted service to sign up for, operate, or trust with your source checkout.
- No new task database, dashboard, queue, account system, or central coordinator.
- GitHub remains the shared workspace your team already uses.
- Agents run with your local tools, credentials, prompts, and runtime permissions.
- Work happens in isolated local worktrees under `~/.grovie/`.
- Results come back as ordinary GitHub branches, pull requests, comments, reviews, and CI checks.
- Local run state, logs, and worktrees stay inspectable on disk.
- Safe publishing is the default: no default-branch pushes and no force-pushes over remote work.

## Who It Is For

Grovie is for developers and small teams who want coding agents to work through normal GitHub issues and pull requests while keeping execution, credentials, source checkouts, and raw logs on their own machines.

It is especially useful when you want local agents to handle queued issue work, produce reviewable pull requests, and leave an auditable trail in GitHub without adopting a hosted agent platform.

## Quick Start

Prerequisites:

- Git
- GitHub CLI authenticated with `gh auth login`
- Node.js 20 or newer
- A local agent runtime such as Codex CLI, Claude Code, or Pi

Install Grovie:

```sh
npm install --global @fankaidev/grovie
grovie --version
grovie --help
```

Check the machine-level worker setup:

```sh
grovie doctor
```

Add repositories to the global daemon schedule:

```sh
grovie watch add owner/repo --label grovie
grovie watch list
```

Start the local daemon:

```sh
grovie daemon start
grovie daemon status
```

Request one issue run from the daemon:

```sh
grovie run owner/repo#123 --agent codex
```

Run the local daemon in the foreground instead:

```sh
grovie daemon
```

Use `--once` when you want exactly one polling cycle:

```sh
grovie daemon --once
```

## Example Workflow

1. Create a GitHub issue, such as `Fix failing login test`.
2. Add the queue label, usually `grovie`.
3. Grovie sees the issue from the local daemon schedule.
4. Grovie prepares an isolated worktree under `~/.grovie/`.
5. The configured local agent receives the issue context and works in that worktree.
6. If code changes are produced, Grovie commits them to a generated branch and opens a pull request.
7. Grovie comments back on the issue with the run id, local log paths, branch, and pull request link.
8. Humans review, merge, or ask the agent to continue using normal GitHub workflow.

An explicit run request follows the same execution path and requires a running daemon:

```sh
grovie run owner/repo#123 --agent codex
```

## How It Works

Grovie is organized around four user-visible areas. The detailed behavior lives in [docs/use-cases](docs/use-cases), with the scenario format described in [docs/bdd.md](docs/bdd.md).

| Area | What it owns |
|------|--------------|
| Worker | Machine identity, local agents, watched repositories, assignment labels, and daemon polling. |
| Execution | One concrete agent run for a GitHub issue, including sessions, runtime handoff, logs, cancellation, and local state. |
| GitHub | Human-visible summaries on issues and pull requests without dumping raw prompts or logs into comments. |
| State repo | Optional remote sync of local run metadata for observability and recovery. |

The main flow is:

1. Configure the local worker with repositories to watch.
2. Create or select a GitHub issue.
3. Request one issue from a running daemon, or let the daemon pick eligible work.
4. Grovie prepares isolated local state and runs the configured runtime.
5. Grovie posts a concise issue result.
6. Grovie publishes the result back to GitHub without pushing to the default branch.

## Agent Coordination Model

Grovie does not include a central semantic coordinator that decides which agent should act next. GitHub remains the shared workspace, and Grovie's daemon performs mechanical routing from visible GitHub state such as issue labels, comments, pull requests, reviews, and CI activity.

An issue can be assigned to multiple local agents. Each assigned agent gets the relevant GitHub context and decides from its own guide, runtime prompt, and the issue timeline whether to act, do nothing, ask for clarification, review work, hand off to another agent, or take a lightweight lead role. Different behavior should come from the agent's instructions and the issue context, not from hidden Grovie workflow rules.

This keeps collaboration inspectable: humans and agents coordinate through normal GitHub artifacts, while Grovie provides isolated runs, local state, logs, cancellation, and safe publishing. Agents that should be proactive can be guided to lead or delegate; agents that should be conservative can be guided to no-op unless they are explicitly mentioned or the issue reaches a relevant state.

## Commands

`grovie watch add owner/repo` creates or updates the global daemon schedule in `~/.grovie/config.yml`. `grovie watch list` shows the configured repositories, and `grovie watch remove owner/repo` removes a repository from that schedule.

`grovie init` writes an optional repo-local `.grovie.yml` with safe local-runner policy defaults. This file controls repository policy, not daemon scheduling.

`grovie doctor` validates the global worker config and any `.grovie.yml` in the current directory, then confirms the current `gh` login plus CLI runtime availability.

`grovie run owner/repo#123 --agent coder@machine` requests one explicit issue run from the running daemon. The daemon owns execution, worktree preparation, logging, and publishing.

`grovie daemon` polls watched repositories from `~/.grovie/config.yml`, resolves each repository's `.grovie.yml`, acquires a local execution lock for one `(issue, agent)` at a time, and runs eligible work locally.

`grovie daemon service install --platform launchd|systemd` writes an optional user service file for macOS LaunchAgent or Linux systemd user service integration. The generated service runs locally and writes stdout/stderr under `~/.grovie/daemon`.

`grovie status` and `grovie runs list` show recent local session status, issue identity, branches, log paths, and last event time. `grovie runs show <run-id>` shows the worktree, run directory, stdout/stderr logs, and recent events for one run.

`grovie runs cleanup --dry-run` previews explicit local cleanup. Without `--dry-run`, completed session worktrees can be removed while preserving session and run history.

## Safety Model

Grovie is a local executor, so it runs with your local filesystem, GitHub credentials, and agent CLI permissions. The safety boundary is intentionally simple:

- `grovie run` derives the target repository from the explicit issue reference and sends the request to a running local daemon.
- `grovie daemon` polls repositories listed in `~/.grovie/config.yml`; that list is scheduling configuration, not an authorization boundary.
- Automatic daemon queue runs require the issue creator to be trusted by repo-local policy; when no trusted authors are configured, the authenticated `gh` user is trusted by default.
- It prepares issue work in isolated worktrees under `~/.grovie/worktrees/`.
- It stores task handoff files and logs under `~/.grovie/runs/`.
- It passes runtime child processes only a small baseline environment plus variables explicitly listed in the configured agent `envKeys`.
- It refuses config that enables default-branch pushes.
- It publishes code changes through a generated Grovie branch.
- It excludes `.grovie/` handoff files from commits and unstages them before commit.
- It does not publish empty code-change results for no-change runs.
- It coordinates daemon work with local execution locks and supports explicit cancellation through issue comments or cancel labels.

## Manual GitHub Checklist

Use this checklist before trusting a new machine or repository:

1. Run `gh auth status` and confirm it is authenticated to the target account.
2. Run `grovie watch add owner/repo --label grovie` for repositories this machine should poll.
3. Optionally run `grovie init` inside a target repository to create a repo-local policy config.
4. Run `grovie doctor` and confirm config, GitHub auth, and Codex availability are green.
5. Create a small test issue in GitHub and label it with the queue label, usually `grovie`.
6. Start the daemon with `grovie daemon start`.
7. Run `grovie run owner/repo#123 --agent codex` from any directory.
8. Confirm the issue receives a Grovie result comment with a run id and local run directory.
9. For code-change runs, confirm Grovie publishes a generated branch and links the result from the issue.
10. Confirm no direct push was made to the default branch.
11. Run `grovie daemon --once` against another labeled issue.
12. Add `/grovie cancel` to a running issue and confirm the daemon marks it canceled.

## Contributing

Grovie is open source, and contributions are welcome. Issues, ideas, documentation improvements, and pull requests are all useful.

Install the current source checkout for development:

```sh
pnpm install
pnpm build
pnpm link --global
grovie --version
grovie --help
```

Use `pnpm check` before opening a pull request when possible.

See [AGENTS.md](AGENTS.md) for development commands, validation, and the lightweight Grovie engineering workflow.
