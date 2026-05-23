# Grovie

Grovie is an open-source, local-first workspace for GitHub-native multi-agent workflows.

It lets you coordinate AI teammates and other local agents without a hosted platform. GitHub stays the control plane for issues, labels, comments, branches, pull requests, reviews, and CI; your local machine stays the executor for agents, worktrees, credentials, and logs.

Grovie keeps adoption and operation simple:

- Free to run: there are no hosted-service seats, usage meters, or per-repository fees.
- Fully open source: the workflow is visible, auditable, and adaptable to your own repositories.
- No extra infrastructure: no server, database, queue, dashboard, account system, or central coordinator.
- GitHub-native by default: coordination happens through ordinary GitHub artifacts your team already uses.
- Local-first execution: source checkouts, credentials, worktrees, prompts, and raw logs stay on your machine.
- No platform lock-in: outputs are normal issue comments, branches, pull requests, reviews, and CI results.
- Inspectable state: local runs, logs, and worktrees live under `~/.grovie/`.

## Mental Model

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
3. Run an agent manually, or let the daemon pick eligible work.
4. Grovie prepares isolated local state and runs the configured runtime.
5. Grovie posts a concise issue result.
6. Grovie publishes the result back to GitHub without pushing to the default branch.

## Quick Start

Prerequisites:

- Git
- GitHub CLI authenticated with `gh auth login`
- A local agent runtime; the current default runtime uses the Codex CLI as `codex`

Install the current source checkout:

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

## Current Implementation

The current implementation includes config initialization and validation, GitHub access through `gh`, local run state under `~/.grovie/`, the first Codex runtime adapter, one-shot issue execution, daemon polling and advisory claiming, cancellation, and result push/PR handling.

`~/.grovie/config.yml` is the global worker config. It contains the repositories the daemon should poll and optional per-repository queue labels. This is scheduling configuration, not a security allowlist; GitHub access is still governed by the local `gh` authentication and repository permissions.

`grovie watch add owner/repo` creates or updates the global worker config. `grovie watch list` shows the configured daemon schedule, and `grovie watch remove owner/repo` removes a repository from that schedule.

`grovie init` writes an optional repo-local `.grovie.yml` with safe local-runner policy defaults. This file is policy configuration, not repository identity or daemon scheduling. The current global `run` and `daemon` paths use built-in policy defaults and do not read `.grovie.yml` from the caller's current directory. `grovie doctor` validates the global worker config and any `.grovie.yml` in the current directory, then confirms the current `gh` login plus Codex CLI availability.

`grovie run owner/repo#123 --agent codex` derives the repository from the issue reference. It reads the issue, refuses to start when another active Grovie task claim owns the issue, prepares an isolated per-attempt local worktree under `~/.grovie/`, runs Codex there, and comments back with the session result, local branch, and run id. In the current code-change path, Grovie commits the worktree, pushes the deterministic issue branch, and opens a pull request. No-change sessions comment back without opening an empty pull request.

`grovie daemon` polls watched repositories from `~/.grovie/config.yml`, claims one visible issue at a time with an editable task-claim comment marker, and runs the same one-shot path. The claim is an advisory GitHub issue comment, not a hard distributed lock; session results are recorded separately in Grovie result comments. The final fixed issue branch push remains the race detector, and Grovie does not force-push over remote work. Use `--repo owner/repo` for an explicit single-repository debugging cycle. A `/grovie cancel` comment or `<label>:cancel` label cancels a claimed run; while Codex is running, the daemon checks cancellation on each heartbeat and terminates the child process.

`grovie status` and `grovie runs list` read local run directories under `~/.grovie/runs/` and show recent session status, issue identity, branches, log paths, and last event time. `grovie runs show <run-id>` shows the worktree, run directory, stdout/stderr logs, and recent events for one run. Runs with a start event but no terminal event are shown as running, and older running-looking runs are marked stale instead of being hidden.

## Use-Case Roadmap

The use-case docs describe accepted product behavior, including behavior that is still being implemented. In particular, the roadmap includes:

- Stable machine and agent identities such as `default@<machine-id>`.
- Long-lived assignment labels using `agent:<agent-id>`.
- Manual run requests that are owned by the daemon instead of the foreground CLI process.
- Persistent sessions keyed by `(issue, agent)`, with deterministic run ids and handled cursors.
- Local execution locks keyed by `(issue, agent)`.
- GitHub-visible summaries that include concise status and PR links while keeping raw prompts and logs out of issue comments.
- Optional private state repository sync for observability and recovery.

Use [docs/use-cases](docs/use-cases) as the behavioral source of truth when adding or reviewing features. Keep README examples focused on the current CLI surface.

## Safety Model

Grovie is a local executor, so it runs with your local filesystem, GitHub credentials, and agent CLI permissions. The safety boundary is intentionally simple:

- `grovie run` derives the target repository from the explicit issue reference.
- `grovie daemon` polls repositories listed in `~/.grovie/config.yml`; that list is scheduling configuration, not an authorization boundary.
- It prepares issue work in isolated worktrees under `~/.grovie/worktrees/`.
- It stores task handoff files and logs under `~/.grovie/runs/`.
- It refuses config that enables default-branch pushes.
- It pushes only the generated Grovie branch, then opens a pull request.
- It excludes `.grovie/` handoff files from commits and unstages them before commit.
- It does not open empty pull requests for no-change runs.
- It coordinates run and daemon work with visible advisory issue comments and supports explicit cancellation for daemon-owned runs.

Current limitations:

- Codex is the only runtime adapter.
- GitHub access uses the local `gh` CLI.
- There is no hosted coordination service; daemon availability depends on your machine.
- Cancellation is cooperative around daemon heartbeats and runtime process termination.
- Grovie does not review or merge generated pull requests for you.
- Several behavior specs in [docs/use-cases](docs/use-cases) are roadmap items, not shipped behavior.

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

## Contributing

Grovie is open source, and contributions are welcome. Issues, ideas, documentation improvements, and pull requests are all useful.

See [AGENTS.md](AGENTS.md) for development commands, validation, and the lightweight Grovie engineering workflow.
