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

The current implementation includes the initial TypeScript CLI scaffold plus config initialization and validation. `run` and `daemon` remain stubs while later MVP issues fill in agent execution behavior.

`grovie init` writes a documented `.grovie.yml` with safe local-runner defaults. Use `grovie init --repo owner/repo` when the repository cannot be inferred from the `origin` remote. `grovie doctor` validates the config and confirms the current `gh` login. Grovie stores local runner state under `~/.grovie/`.

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
