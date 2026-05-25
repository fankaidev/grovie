import type { IssueReference, Result } from "./types.js";

export function parseIssueReference(value: string): Result<IssueReference> {
  const match = /^(?<owner>[A-Za-z0-9.-]+)\/(?<repo>[A-Za-z0-9._-]+)#(?<number>[1-9]\d*)$/.exec(value);

  if (match?.groups === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: `Invalid issue reference "${value}". Expected owner/repo#123.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      owner: match.groups.owner,
      repo: match.groups.repo,
      number: Number.parseInt(match.groups.number, 10),
    },
  };
}

export function formatIssueReference(reference: IssueReference): string {
  return `${formatRepository(reference)}#${reference.number}`;
}

export function formatRepository(reference: Pick<IssueReference, "owner" | "repo">): string {
  return `${reference.owner}/${reference.repo}`;
}

export function parseRepositoryName(repository: string): Result<Pick<IssueReference, "owner" | "repo">> {
  const match = /^(?<owner>[A-Za-z0-9.-]+)\/(?<repo>[A-Za-z0-9._-]+)$/.exec(repository);

  if (match?.groups === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_issue_reference",
        message: `Invalid repository "${repository}". Expected owner/repo.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      owner: match.groups.owner,
      repo: match.groups.repo,
    },
  };
}
