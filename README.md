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
grovie --help
```

Create a Grovie config in the repository where you want to run issues:

```sh
grovie init --repo owner/repo
grovie doctor
```

Run one issue:

```sh
grovie run owner/repo#123 --agent codex
```

Run a local daemon for queued issues:

```sh
grovie daemon --label grovie
```

Use `--once` when you want exactly one polling cycle:

```sh
grovie daemon --label grovie --once
```

## How It Works

The current implementation includes config initialization and validation, GitHub access through `gh`, local run state under `~/.grovie/`, the first Codex runtime adapter, one-shot issue execution, daemon polling and claiming, cancellation, and result push/PR handling.

`grovie init` writes a documented `.grovie.yml` with safe local-runner defaults and a single repo identity:

```yaml
version: 1
repository: owner/repo
```

Use `grovie init --repo owner/repo` when the repository cannot be inferred from the `origin` remote. `grovie doctor` validates the config, shows the configured repository, and confirms the current `gh` login plus Codex CLI availability. Grovie stores local runner state under `~/.grovie/`.

`grovie run owner/repo#123 --agent codex` reads the issue, prepares an isolated local worktree, runs Codex there, and comments back with the result, local branch, and run id. If files changed, Grovie commits the worktree, pushes the Grovie branch, and opens a pull request. No-change runs comment back without opening an empty PR.

`grovie daemon --label grovie` polls open issues in the configured repository, claims one visible issue at a time with an editable comment marker, and runs the same one-shot path. Use `--repo owner/repo` only when you want to be explicit; Grovie rejects it if it does not match `.grovie.yml`. Use `--once` for a single polling cycle. A `/grovie cancel` comment or `<label>:cancel` label cancels a claimed run; while Codex is running, the daemon checks cancellation on each heartbeat and terminates the child process.

## Safety Model

Grovie is a local executor, so it runs with your local filesystem, GitHub credentials, and agent CLI permissions. The MVP keeps the safety boundary simple:

- It only runs the repository named by `.grovie.yml`.
- It prepares issue work in isolated worktrees under `~/.grovie/worktrees/`.
- It stores task handoff files and logs under `~/.grovie/runs/`.
- It refuses config that enables default-branch pushes.
- It pushes only the generated Grovie branch, then opens a pull request.
- It excludes `.grovie/` handoff files from commits and unstages them before commit.
- It does not open empty pull requests for no-change runs.
- It claims daemon work with visible issue comments and supports explicit cancellation.

Current MVP limitations:

- Codex is the only runtime adapter.
- GitHub access uses the local `gh` CLI.
- There is no hosted coordination service; daemon availability depends on your machine.
- Cancellation is cooperative around daemon heartbeats and runtime process termination.
- Grovie does not review or merge generated pull requests for you.

## Manual GitHub Checklist

Use this checklist before trusting a new machine or repository:

1. Run `gh auth status` and confirm it is authenticated to the target account.
2. In the target repository, run `grovie init --repo owner/repo`.
3. Run `grovie doctor` and confirm config, GitHub auth, and Codex availability are green.
4. Create a small test issue in GitHub and label it with the queue label, usually `grovie`.
5. Run `grovie run owner/repo#123 --agent codex`.
6. Confirm the issue receives a Grovie result comment with a run id and local run directory.
7. Confirm changed runs push a Grovie branch and open a pull request against the default branch.
8. Confirm no direct push was made to the default branch.
9. Run `grovie daemon --label grovie --once` against another labeled issue.
10. Add `/grovie cancel` to a claimed issue and confirm the daemon marks it canceled.

## Development

```sh
pnpm install
pnpm dev -- --help
pnpm check
```

## Local CLI Install

To install the current checkout as a real `grovie` command during development:

```sh
pnpm install
pnpm build
pnpm link --global
grovie --help
```

To remove the local global command:

```sh
pnpm remove --global grovie
```

CI runs `pnpm check` on pull requests and pushes to `main`.

## Engineering Workflow

See [AGENTS.md](AGENTS.md) for the lightweight Grovie workflow.
