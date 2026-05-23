# BDD Workflow Specification

## Core Concepts

| Concept | Definition |
|---------|------------|
| **Use Case** | A user-visible Grovie capability that explains why the behavior exists and what value it provides. |
| **Scenario** | A representative example of the observable behavior for that capability. |

- Use cases describe product behavior, not source files.
- Scenarios are representative, not exhaustive.
- Keep scenario wording short and concrete. Do not turn a scenario into a test implementation checklist.
- Scenarios should map to one or a few real automated tests. Include enough state, action, and observable result that a test author does not have to guess the fixture.
- Use cases may describe accepted target behavior before the implementation exists. When they do, keep the scenario testable and let implementation issues close the gap.

## Optional Rules

Rules are optional workflow invariants that apply across scenarios. Use them only
for foundational constraints that would be costly to repeat or easy to miss.

Good examples:

- Grovie never pushes directly to the default branch.
- A local execution lock prevents duplicate execution for the same issue and agent.
- Local logs remain inspectable after execution finishes.

Do not try to capture every rule. Avoid rules that only restate implementation
details, repeat one scenario, or turn the use case into a full specification.

## Priority

| Priority | Meaning |
|----------|---------|
| P0 | Core path; failure breaks the main Grovie workflow. |
| P1 | Important branch or common edge case. |
| P2 | Low-frequency edge case or auxiliary experience. |

## File Specification

```text
docs/use-cases/
  {domain}/
    {use-case-name}.md
```

Domains should follow user/system boundaries, not internal nouns:

| Domain | Boundary |
|--------|----------|
| `worker` | Who watches GitHub and decides what should run. |
| `execution` | How one agent run is requested, executed, preserved, and published. |
| `github` | What humans see in project repositories. |
| `state-repo` | Optional remote observability and recovery storage. |

Each file contains one use case:

- title with use case ID
- user value summary
- optional Rules table
- Scenarios table

Scenario table format:

```text
| ID | Priority | Scenario |
|----|----------|----------|
| UC-DOMAIN-001-S01 | P0 | A ready issue with no active execution lock runs once and posts a succeeded run comment. |
```

## ID Naming Convention

- Use Case ID: `UC-{DOMAIN}-{NNN}`.
- Scenario ID: `UC-{DOMAIN}-{NNN}-S{NN}`.
- Scenario IDs are globally unique.
- If automated tests cover a scenario, include the scenario ID in the test name.

## Non-Goals

- Scenarios do not need a one-to-one correspondence with tests.
- Scenarios do not need to exhaustively list every edge case.
- BDD files should not document speculative architecture unless it is already accepted target behavior in a design issue.
