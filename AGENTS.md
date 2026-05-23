# Grovie Engineering Guide

Grovie is a lightweight GitHub-native local runner for coding agents.

Keep the project small:

- GitHub is the control plane: issues, labels, comments, branches, and pull requests.
- The local machine is the executor: `gh`, `git`, local agent CLIs, worktrees, and logs.
- Do not add a hosted server, web dashboard, account system, or central database for the MVP.

## Workflow

- Use `pnpm` for dependency management and script execution.
- Use the `gh` CLI for GitHub operations.
- Use GitHub issues for non-trivial work.
- For non-trivial behavior changes, follow `docs/bdd.md` and update the relevant use cases under `docs/use-cases/`.
- Mark active issues with `in-progress` and `worker:grovie`.
- Create branches from `origin/main` with the format `issue-{number}`.
- Never push directly to `main`.
- Do not amend commits or force-push existing branches; add a new commit and use a normal push when updating a PR.
- Open a pull request for every change, including small fixes.
- Run `pnpm check` before opening a PR when possible.
- After opening or materially updating a PR, automatically start an independent subagent review. The reviewer should read the linked issue and PR, inspect the diff, check that the implementation matches the issue intent, and submit the result with `gh pr review --comment`.
- Treat green checks as necessary but not sufficient; compare the final diff against the issue intent.

## Pull Requests

PR titles should use Conventional Commits:

- `feat:` for new user-visible behavior
- `fix:` for bug fixes
- `docs:` for documentation-only changes
- `chore:` for maintenance
- `refactor:` for behavior-preserving code changes
- `test:` for test-only changes

Every PR should link its issue with `Closes #{number}` when it completes the issue.

## Language

All project artifacts must be in English:

- Code identifiers and comments
- Documentation
- GitHub issues and pull requests
- Commit messages
- CLI output and error messages

## Design Defaults

- Prefer explicit inputs and narrow types.
- Keep runtime adapters behind small interfaces.
- Keep GitHub access behind a small gateway so the MVP can start with `gh` and move to Octokit later if needed.
- Keep local run state inspectable on disk.
- Default to safe behavior: no default-branch pushes, no force-pushes, no hidden destructive cleanup.
