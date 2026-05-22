# Grovie

Grovie is a lightweight GitHub-native local runner for coding agents.

The MVP keeps the product intentionally small:

- GitHub is the control plane: issues, labels, comments, branches, and pull requests.
- The local machine is the executor: `gh`, `git`, Codex or another local agent CLI, worktrees, and logs.
- There is no hosted server, web dashboard, account system, or central database.

## MVP Commands

```sh
grovie init
grovie doctor
grovie run owner/repo#123 --agent codex
grovie daemon --repo owner/repo --label grovie
```

The current implementation includes the initial TypeScript CLI scaffold, config initialization and validation, GitHub access, local run state, the first Codex runtime adapter, one-shot issue execution, daemon polling, and result push/PR handling.

`grovie init` writes a documented `.grovie.yml` with safe local-runner defaults. Use `grovie init --repo owner/repo` when the repository cannot be inferred from the `origin` remote. `grovie doctor` validates the config and confirms the current `gh` login plus Codex CLI availability. Grovie stores local runner state under `~/.grovie/`.

`grovie run owner/repo#123 --agent codex` reads the issue, prepares an isolated local worktree, runs Codex there, and comments back with the result, local branch, and run id. If files changed, Grovie commits the worktree, pushes the Grovie branch, and opens a pull request. No-change runs comment back without opening an empty PR.

`grovie daemon --repo owner/repo --label grovie` polls open issues with the queue label, claims one visible issue at a time with an editable comment marker, and runs the same one-shot path. Use `--once` for a single polling cycle. A `/grovie cancel` comment or `<label>:cancel` label cancels a claimed run; while Codex is running, the daemon checks cancellation on each heartbeat and terminates the child process.

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

## Engineering Workflow

See [AGENTS.md](AGENTS.md) for the lightweight Grovie workflow.
