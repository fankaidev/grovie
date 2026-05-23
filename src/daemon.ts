import type { GrovieConfig } from "./config.js";
import {
  createIssueClaim,
  DEFAULT_STALE_CLAIM_MS,
  hasCancelRequest,
  isIssueClaimable,
  selectActiveClaim,
  updateIssueClaim,
} from "./claim.js";
import {
  formatIssueReference,
  type GitHubGateway,
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

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export async function runDaemon(input: DaemonInput): Promise<RunIssueResult> {
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

    if (!isIssueClaimable(issueResult.value, input.label, now(), input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS)) {
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
  const claimResult = createIssueClaim({
    github: input.github,
    issueReference: input.issueReference,
    actor: "daemon",
    workerId: input.workerId,
    now: input.now(),
  });

  if (!claimResult.ok) {
    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: claimResult.message,
    });
  }

  const rereadResult = input.github.readIssue(input.issueReference);

  if (!rereadResult.ok) {
    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: rereadResult.error.message,
    });
  }

  const rereadIssue = rereadResult.value;
  const claimOwner = selectActiveClaim(
    rereadIssue,
    input.now(),
    input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
  );

  if (claimOwner?.id !== claimResult.claim.commentId) {
    updateIssueClaim(input.github, claimResult.claim, "skipped", input.now(), "Another visible claim owns this issue.");

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
    updateIssueClaim(
      input.github,
      claimResult.claim,
      "canceled",
      input.now(),
      "Cancellation was requested before runtime start.",
    );

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

  updateIssueClaim(input.github, claimResult.claim, "running", input.now());

  const result = await input.issueRunner({
    issueReference: input.issueReference,
    repository: input.repository,
    config: input.config,
    configPath: input.configPath,
    agent: "codex",
    github: input.github,
    runtime: input.runtime,
    localState: input.localState,
    monitor: {
      heartbeatIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      onHeartbeat: () => {
        updateIssueClaim(input.github, claimResult.claim, "running", input.now());
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

  updateIssueClaim(
    input.github,
    claimResult.claim,
    result.canceled === true ? "canceled" : result.exitCode === 0 ? "completed" : "failed",
    input.now(),
    result.canceled === true
      ? "Run canceled."
      : result.exitCode === 0
        ? "Run completed."
        : "Run failed. See the Grovie result comment and local run logs.",
  );

  return {
    ...result,
    processed: true,
  };
}

function sleepSync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
