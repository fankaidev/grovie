import type { GrovieConfig } from "./config.js";
import {
  formatIssueReference,
  type GitHubComment,
  type GitHubGateway,
  type GitHubIssue,
  type IssueReference,
} from "./github.js";
import type { RunIssueAsyncInput, RunIssueResult, RunLocalState } from "./run.js";
import { runIssueAsync } from "./run.js";
import type { AgentRuntime } from "./runtime.js";

export type DaemonInput = {
  repository: string;
  label: string;
  config: GrovieConfig;
  configPath: string;
  github: GitHubGateway;
  runtime?: AgentRuntime;
  localState?: RunLocalState;
  once: boolean;
  workerId?: string;
  pollIntervalMs?: number;
  staleClaimMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => void | Promise<void>;
  issueRunner?: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
};

type DaemonCycleResult = RunIssueResult & {
  processed: boolean;
};

type ClaimStatus = "claimed" | "running" | "completed" | "failed" | "canceled" | "skipped";

type Claim = {
  id: number;
  workerId: string;
  status: ClaimStatus;
  updatedAt: string;
};

const CLAIM_MARKER = "grovie:claim";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STALE_CLAIM_MS = 60 * 60 * 1000;

export async function runDaemon(input: DaemonInput): Promise<RunIssueResult> {
  if (!input.config.repositories.allowed.includes(input.repository)) {
    return {
      exitCode: 1,
      stderr: `Repository ${input.repository} is not allowed by ${input.configPath}.`,
    };
  }

  if (input.once) {
    return toRunIssueResult(await runDaemonCycle(input));
  }

  while (true) {
    await runDaemonCycle(input);
    const sleep = input.sleep ?? sleepSync;
    await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

function toRunIssueResult(result: DaemonCycleResult): RunIssueResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runDaemonCycle(input: DaemonInput): Promise<DaemonCycleResult> {
  const now = input.now ?? (() => new Date());
  const workerId = input.workerId ?? `grovie-${process.pid}`;
  const issueRunner = input.issueRunner ?? runIssueAsync;
  const listResult = input.github.listOpenIssues(input.repository, input.label);

  if (!listResult.ok) {
    return {
      exitCode: 1,
      processed: false,
      stderr: listResult.error.message,
    };
  }

  for (const summary of listResult.value) {
    const issueResult = input.github.readIssue(summary.reference);

    if (!issueResult.ok) {
      return {
        exitCode: 1,
        processed: false,
        stderr: issueResult.error.message,
      };
    }

    if (!isEligibleIssue(issueResult.value, input.label, now(), input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS)) {
      continue;
    }

    return claimAndRun({
      ...input,
      issueReference: summary.reference,
      workerId,
      now,
      issueRunner,
    });
  }

  return {
    exitCode: 0,
    processed: false,
    stdout: [
      "grovie daemon",
      "",
      `No queued issues found for ${input.repository} with label ${input.label}.`,
    ].join("\n"),
  };
}

async function claimAndRun(input: DaemonInput & {
  issueReference: IssueReference;
  workerId: string;
  now: () => Date;
  issueRunner: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
}): Promise<DaemonCycleResult> {
  const claimedAt = input.now().toISOString();
  const claimResult = input.github.createIssueComment(
    input.issueReference,
    renderClaimComment({
      status: "claimed",
      workerId: input.workerId,
      claimedAt,
      heartbeatAt: claimedAt,
    }),
  );

  if (!claimResult.ok) {
    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: claimResult.error.message,
    });
  }

  const repository = formatRepository(input.issueReference);
  const rereadResult = input.github.readIssue(input.issueReference);

  if (!rereadResult.ok) {
    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: rereadResult.error.message,
    });
  }

  const rereadIssue = rereadResult.value;
  const claimOwner = selectClaimOwner(
    rereadIssue,
    input.now(),
    input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
  );

  if (claimOwner?.id !== claimResult.value.id) {
    updateClaim(input.github, repository, claimResult.value.id, {
      status: "skipped",
      workerId: input.workerId,
      claimedAt,
      heartbeatAt: input.now().toISOString(),
      note: "Another visible claim owns this issue.",
    });

    return Promise.resolve({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        `Skipped ${formatIssueReference(input.issueReference)} because another claim is visible.`,
      ].join("\n"),
    });
  }

  if (hasCancelRequest(rereadIssue, input.label)) {
    updateClaim(input.github, repository, claimResult.value.id, {
      status: "canceled",
      workerId: input.workerId,
      claimedAt,
      heartbeatAt: input.now().toISOString(),
      note: "Cancellation was requested before runtime start.",
    });

    return Promise.resolve({
      exitCode: 0,
      processed: true,
      stdout: [
        "grovie daemon",
        "",
        `Canceled ${formatIssueReference(input.issueReference)} before runtime start.`,
      ].join("\n"),
    });
  }

  updateClaim(input.github, repository, claimResult.value.id, {
    status: "running",
    workerId: input.workerId,
    claimedAt,
    heartbeatAt: input.now().toISOString(),
  });

  const result = await input.issueRunner({
    issueReference: input.issueReference,
    config: input.config,
    configPath: input.configPath,
    agent: "codex",
    github: input.github,
    runtime: input.runtime,
    localState: input.localState,
    monitor: {
      heartbeatIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      onHeartbeat: () => {
        updateClaim(input.github, repository, claimResult.value.id, {
          status: "running",
          workerId: input.workerId,
          claimedAt,
          heartbeatAt: input.now().toISOString(),
        });
      },
      shouldCancel: () => {
        const latestIssue = input.github.readIssue(input.issueReference);

        if (!latestIssue.ok) {
          return false;
        }

        return hasCancelRequest(latestIssue.value, input.label);
      },
    },
  });

  updateClaim(input.github, repository, claimResult.value.id, {
    status: result.canceled === true ? "canceled" : result.exitCode === 0 ? "completed" : "failed",
    workerId: input.workerId,
    claimedAt,
    heartbeatAt: input.now().toISOString(),
    note:
      result.canceled === true
        ? "Run canceled."
        : result.exitCode === 0
          ? "Run completed."
          : "Run failed. See the Grovie result comment and local run logs.",
  });

  return {
    ...result,
    processed: true,
  };
}

function isEligibleIssue(issue: GitHubIssue, queueLabel: string, now: Date, staleClaimMs: number): boolean {
  if (hasCancelRequest(issue, queueLabel)) {
    return false;
  }

  return selectClaimOwner(issue, now, staleClaimMs) === undefined;
}

function hasCancelRequest(issue: GitHubIssue, queueLabel: string): boolean {
  const cancelLabel = `${queueLabel}:cancel`;

  return (
    issue.labels.includes(cancelLabel) ||
    issue.comments.some((comment) => comment.body.split("\n").some((line) => line.trim() === "/grovie cancel"))
  );
}

function selectClaimOwner(issue: GitHubIssue, now: Date, staleClaimMs: number): Claim | undefined {
  const activeClaims = issue.comments
    .map(parseClaim)
    .filter((claim): claim is Claim => claim !== undefined)
    .filter((claim) => isActiveClaim(claim, now, staleClaimMs))
    .sort((left, right) => {
      const byUpdatedAt = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      return byUpdatedAt === 0 ? left.id - right.id : byUpdatedAt;
    });

  return activeClaims[0];
}

function isActiveClaim(claim: Claim, now: Date, staleClaimMs: number): boolean {
  if (claim.status !== "claimed" && claim.status !== "running") {
    return false;
  }

  const updatedAt = Date.parse(claim.updatedAt);

  if (Number.isNaN(updatedAt)) {
    return true;
  }

  return now.getTime() - updatedAt <= staleClaimMs;
}

function parseClaim(comment: GitHubComment): Claim | undefined {
  const marker = new RegExp(`<!-- ${CLAIM_MARKER} (?<json>[^\\n]+) -->`).exec(comment.body);
  const rawJson = marker?.groups?.json;

  if (rawJson === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as Partial<Pick<Claim, "workerId" | "status">>;

    if (parsed.workerId === undefined || parsed.status === undefined) {
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

function updateClaim(
  github: GitHubGateway,
  repository: string,
  commentId: number,
  input: {
    status: ClaimStatus;
    workerId: string;
    claimedAt: string;
    heartbeatAt: string;
    note?: string;
  },
): void {
  github.updateIssueComment(repository, commentId, renderClaimComment(input));
}

function renderClaimComment(input: {
  status: ClaimStatus;
  workerId: string;
  claimedAt: string;
  heartbeatAt: string;
  note?: string;
}): string {
  const marker = `<!-- ${CLAIM_MARKER} ${JSON.stringify({
    workerId: input.workerId,
    status: input.status,
  })} -->`;
  const lines = [
    marker,
    `Grovie daemon ${input.status}.`,
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

function sleepSync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
