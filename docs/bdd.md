# BDD Workflow Specification

## Core Concepts

| Concept | Definition |
|---------|------------|
| **Use Case** | A user-visible Grovie capability that explains why the behavior exists and what value it provides. |
| **Scenario** | A representative example of the observable behavior for that capability. |

- Use cases describe product behavior, not source files.
- Scenarios are representative, not exhaustive.
- Keep scenario wording short and concrete. Do not turn a scenario into a test implementation checklist.

## Rules

Rules are workflow invariants that apply across scenarios.

Good examples:

- Grovie never pushes directly to the default branch.
- A visible active claim prevents duplicate execution.
- Local logs remain inspectable after execution finishes.

Avoid rules that only restate implementation details or one-off assertions.

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

Each file contains one use case:

- title with use case ID
- user value summary
- optional Rules table
- Scenarios table

Scenario table format:

```text
| ID | Priority | Scenario | Rules |
|----|----------|----------|-------|
| UC-DOMAIN-001-S01 | P0 | Running the main workflow produces the expected user-visible result. | R1 |
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
