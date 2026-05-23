import {
  formatIssueReference,
  type GitHubComment,
  type GitHubGateway,
  type GitHubIssue,
  type IssueReference,
} from "./github.js";

export type ClaimActor = "daemon" | "run";
export type ClaimStatus = "claimed" | "running" | "completed" | "failed" | "canceled" | "skipped";

export type ActiveClaim = {
  id: number;
  workerId: string;
  status: ClaimStatus;
  updatedAt: string;
};

export type IssueClaim = {
  commentId: number;
  repository: string;
  issueReference: IssueReference;
  actor: ClaimActor;
  workerId: string;
  claimedAt: string;
};

export const DEFAULT_STALE_CLAIM_MS = 60 * 60 * 1000;

const CLAIM_MARKER = "grovie:claim";

export function createIssueClaim(input: {
  github: GitHubGateway;
  issueReference: IssueReference;
  actor: ClaimActor;
  workerId: string;
  now: Date;
}): { ok: true; claim: IssueClaim } | { ok: false; message: string } {
  const claimedAt = input.now.toISOString();
  const result = input.github.createIssueComment(
    input.issueReference,
    renderClaimComment({
      status: "claimed",
      actor: input.actor,
      workerId: input.workerId,
      claimedAt,
      heartbeatAt: claimedAt,
    }),
  );

  if (!result.ok) {
    return {
      ok: false,
      message: result.error.message,
    };
  }

  return {
    ok: true,
    claim: {
      commentId: result.value.id,
      repository: formatRepository(input.issueReference),
      issueReference: input.issueReference,
      actor: input.actor,
      workerId: input.workerId,
      claimedAt,
    },
  };
}

export function updateIssueClaim(
  github: GitHubGateway,
  claim: IssueClaim,
  status: ClaimStatus,
  heartbeatAt: Date,
  note?: string,
): void {
  github.updateIssueComment(
    claim.repository,
    claim.commentId,
    renderClaimComment({
      status,
      actor: claim.actor,
      workerId: claim.workerId,
      claimedAt: claim.claimedAt,
      heartbeatAt: heartbeatAt.toISOString(),
      note,
    }),
  );
}

export function isIssueClaimable(issue: GitHubIssue, queueLabel: string, now: Date, staleClaimMs: number): boolean {
  if (hasCancelRequest(issue, queueLabel)) {
    return false;
  }

  return selectActiveClaim(issue, now, staleClaimMs) === undefined;
}

export function selectActiveClaim(issue: GitHubIssue, now: Date, staleClaimMs: number): ActiveClaim | undefined {
  const activeClaims = issue.comments
    .map(parseClaim)
    .filter((claim): claim is ActiveClaim => claim !== undefined)
    .filter((claim) => isActiveClaim(claim, now, staleClaimMs))
    .sort((left, right) => {
      const byUpdatedAt = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      return byUpdatedAt === 0 ? left.id - right.id : byUpdatedAt;
    });

  return activeClaims[0];
}

export function hasCancelRequest(issue: GitHubIssue, queueLabel: string): boolean {
  const cancelLabel = `${queueLabel}:cancel`;

  return (
    issue.labels.includes(cancelLabel) ||
    issue.comments.some((comment) => comment.body.split("\n").some((line) => line.trim() === "/grovie cancel"))
  );
}

export function renderActiveClaimMessage(issue: IssueReference, claim: ActiveClaim): string {
  return [
    `Issue ${formatIssueReference(issue)} already has an active Grovie claim.`,
    `Claim owner: ${claim.workerId}.`,
    `Claim comment: ${claim.id}.`,
  ].join(" ");
}

function parseClaim(comment: GitHubComment): ActiveClaim | undefined {
  const marker = new RegExp(`<!-- ${CLAIM_MARKER} (?<json>[^\\n]+) -->`).exec(comment.body);
  const rawJson = marker?.groups?.json;

  if (rawJson === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as Partial<Pick<ActiveClaim, "workerId" | "status">>;

    if (parsed.workerId === undefined || !isClaimStatus(parsed.status)) {
      return undefined;
    }

    return {
      id: comment.id,
      workerId: parsed.workerId,
      status: parsed.status,
      updatedAt: comment.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function isClaimStatus(value: unknown): value is ClaimStatus {
  return (
    value === "claimed" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled" ||
    value === "skipped"
  );
}

function isActiveClaim(claim: ActiveClaim, now: Date, staleClaimMs: number): boolean {
  if (claim.status !== "claimed" && claim.status !== "running") {
    return false;
  }

  const updatedAt = Date.parse(claim.updatedAt);

  if (Number.isNaN(updatedAt)) {
    return true;
  }

  return now.getTime() - updatedAt <= staleClaimMs;
}

function renderClaimComment(input: {
  status: ClaimStatus;
  actor: ClaimActor;
  workerId: string;
  claimedAt: string;
  heartbeatAt: string;
  note?: string;
}): string {
  const marker = `<!-- ${CLAIM_MARKER} ${JSON.stringify({
    workerId: input.workerId,
    status: input.status,
    actor: input.actor,
  })} -->`;
  const lines = [
    marker,
    `Grovie ${input.actor} ${input.status}.`,
    "",
    `- Worker: \`${input.workerId}\``,
    `- Status: ${input.status}`,
    `- Claimed at: ${input.claimedAt}`,
    `- Last heartbeat: ${input.heartbeatAt}`,
  ];

  if (input.note !== undefined) {
    lines.push(`- Note: ${input.note}`);
  }

  return lines.join("\n");
}

function formatRepository(reference: Pick<IssueReference, "owner" | "repo">): string {
  return `${reference.owner}/${reference.repo}`;
}
