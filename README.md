# Grovie

Grovie is a lightweight GitHub-native local runner for coding agents.

The MVP keeps the product intentionally small and easy to reason about:

- GitHub is the control plane: issues, labels, comments, branches, and pull requests.
- The local machine is the executor: `gh`, `git`, Codex or another local agent CLI, worktrees, and logs.
- There is no hosted server, web dashboard, account system, or central database.

## Quick Start

Prerequisites:

- Node.js 20 or newer
- pnpm 10.26.1
- Git
- GitHub CLI authenticated with `gh auth login`
- Codex CLI available as `codex`

Install this checkout as a local development command:

```sh
pnpm install
pnpm build
pnpm link --global
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

Run one issue:

```sh
grovie run owner/repo#123 --agent codex
```

Run a local daemon for queued issues:

```sh
grovie daemon
```

Use `--once` when you want exactly one polling cycle:

```sh
grovie daemon --once
```

## How It Works

The current implementation includes config initialization and validation, GitHub access through `gh`, local run state under `~/.grovie/`, the first Codex runtime adapter, one-shot issue execution, daemon polling and claiming, cancellation, and result push/PR handling.

`~/.grovie/config.yml` is the global worker config. It contains the repositories the daemon should poll and optional per-repository queue labels. This is a scheduling list, not a security allowlist; GitHub access is still governed by the local `gh` authentication and repository permissions.

`grovie watch add owner/repo` creates or updates the global worker config. `grovie watch list` shows the configured daemon schedule, and `grovie watch remove owner/repo` removes a repository from that schedule.

`grovie init` still writes an optional, documented repo-local `.grovie.yml` with safe local-runner policy defaults. This file is policy configuration, not repository identity or daemon scheduling. The current global `run` and `daemon` paths use built-in policy defaults and do not read `.grovie.yml` from the caller's current directory. `grovie doctor` validates the global worker config and any `.grovie.yml` in the current directory, then confirms the current `gh` login plus Codex CLI availability. Grovie stores local runner state under `~/.grovie/`.

`grovie run owner/repo#123 --agent codex` derives the repository from the issue reference. It reads the issue, refuses to start when another active Grovie claim owns the issue, prepares an isolated per-attempt local worktree under `~/.grovie/`, runs Codex there, and comments back with the result, local branch, and run id. If files changed, Grovie commits the worktree, pushes the deterministic issue branch, and opens a pull request. No-change runs comment back without opening an empty PR.

`grovie daemon` polls watched repositories from `~/.grovie/config.yml`, claims one visible issue at a time with an editable comment marker, and runs the same one-shot path. The claim is an advisory GitHub issue comment, not a hard distributed lock; the final fixed issue branch push remains the race detector, and Grovie does not force-push over remote work. Use `--once` for a single polling cycle. Use `--repo owner/repo` for an explicit single-repository debugging cycle. A `/grovie cancel` comment or `<label>:cancel` label cancels a claimed run; while Codex is running, the daemon checks cancellation on each heartbeat and terminates the child process.

## Safety Model

Grovie is a local executor, so it runs with your local filesystem, GitHub credentials, and agent CLI permissions. The MVP keeps the safety boundary simple:

- `grovie run` derives the target repository from the explicit issue reference.
- `grovie daemon` polls repositories listed in `~/.grovie/config.yml`; that list is scheduling configuration, not an authorization boundary.
- It prepares issue work in per-attempt isolated worktrees under `~/.grovie/worktrees/`.
- It stores task handoff files and logs under `~/.grovie/runs/`.
- It refuses config that enables default-branch pushes.
- It pushes only the generated Grovie branch, then opens a pull request.
- It excludes `.grovie/` handoff files from commits and unstages them before commit.
- It does not open empty pull requests for no-change runs.
- It coordinates run and daemon work with visible advisory issue comments and supports explicit cancellation for daemon-owned runs.

Current MVP limitations:

- Codex is the only runtime adapter.
- GitHub access uses the local `gh` CLI.
- There is no hosted coordination service; daemon availability depends on your machine.
- Cancellation is cooperative around daemon heartbeats and runtime process termination.
- Grovie does not review or merge generated pull requests for you.

## Manual GitHub Checklist

Use this checklist before trusting a new machine or repository:

1. Run `gh auth status` and confirm it is authenticated to the target account.
2. Run `grovie watch add owner/repo --label grovie` for repositories this machine should poll.
3. Optionally run `grovie init` inside a target repository to create a repo-local policy config.
4. Run `grovie doctor` and confirm config, GitHub auth, and Codex availability are green.
5. Create a small test issue in GitHub and label it with the queue label, usually `grovie`.
6. Run `grovie run owner/repo#123 --agent codex` from any directory.
7. Confirm the issue receives a Grovie result comment with a run id and local run directory.
8. Confirm changed runs push a Grovie branch and open a pull request against the default branch.
9. Confirm no direct push was made to the default branch.
10. Run `grovie daemon --once` against another labeled issue.
11. Add `/grovie cancel` to a claimed issue and confirm the daemon marks it canceled.

## Development

```sh
pnpm install
pnpm dev -- --help
pnpm dev -- --version
pnpm check
```

## Local CLI Install

To install the current checkout as a real `grovie` command during development:

```sh
pnpm install
pnpm build
pnpm link --global
grovie --version
grovie --help
```

To remove the local global command:

```sh
pnpm remove --global grovie
```

CI runs `pnpm check` on pull requests and pushes to `main`.

## Engineering Workflow

See [AGENTS.md](AGENTS.md) for the lightweight Grovie workflow.
