import { createHash } from "node:crypto";
import type { GrovieConfig } from "./config.js";
import { getAssignedAgentIds, isAssignedToLocalMachine } from "./assignment.js";
import {
  createIssueClaim,
  hasCancelRequest,
  updateIssueClaim,
} from "./claim.js";
import {
  formatIssueReference,
  type GitHubGateway,
  type GitHubIssue,
  type IssueReference,
} from "./github.js";
import { resolveLocalIdentity } from "./identity.js";
import type { DaemonLock, ExecutionLock } from "./local-state.js";
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
  now?: () => Date;
  sleep?: (ms: number) => void | Promise<void>;
  issueRunner?: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
};

export type DaemonRepositoryInput = {
  repository: string;
  label: string;
};

export type MultiRepositoryDaemonInput = Omit<DaemonInput, "repository" | "label"> & {
  repositories: DaemonRepositoryInput[];
};

type DaemonCycleResult = RunIssueResult & {
  processed: boolean;
};

type IssueActivity = {
  timestamp: string;
  issueFingerprint: string;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export async function runDaemon(input: DaemonInput): Promise<RunIssueResult> {
  const daemonLockResult = acquireDaemonLock(input);

  if (!daemonLockResult.ok) {
    return {
      exitCode: 1,
      stderr: daemonLockResult.message,
    };
  }

  if (input.once) {
    try {
      return toRunIssueResult(await runDaemonCycle(input));
    } finally {
      releaseDaemonLock(input, daemonLockResult.lock);
    }
  }

  try {
    while (true) {
      await runDaemonCycle(input);
      const sleep = input.sleep ?? sleepSync;
      await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    releaseDaemonLock(input, daemonLockResult.lock);
  }
}

export async function runDaemonForRepositories(input: MultiRepositoryDaemonInput): Promise<RunIssueResult> {
  const daemonLockResult = acquireDaemonLock(input);

  if (!daemonLockResult.ok) {
    return {
      exitCode: 1,
      stderr: daemonLockResult.message,
    };
  }

  if (input.repositories.length === 0) {
    releaseDaemonLock(input, daemonLockResult.lock);

    return {
      exitCode: 1,
      stderr: "No watched repositories configured. Add one with `grovie watch add owner/repo`.",
    };
  }

  if (!input.once) {
    try {
      while (true) {
        await runDaemonRepositoryCycle(input);
        const sleep = input.sleep ?? sleepSync;
        await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      }
    } finally {
      releaseDaemonLock(input, daemonLockResult.lock);
    }
  }

  try {
    return toRunIssueResult(await runDaemonRepositoryCycle(input));
  } finally {
    releaseDaemonLock(input, daemonLockResult.lock);
  }
}

async function runDaemonRepositoryCycle(input: MultiRepositoryDaemonInput): Promise<DaemonCycleResult> {
  const idleMessages: string[] = [];

  for (const repository of input.repositories) {
    const result = await runDaemonCycle({
      ...input,
      repository: repository.repository,
      label: repository.label,
    });

    if (result.exitCode !== 0 || result.processed) {
      return result;
    }

    if (result.stdout !== undefined) {
      idleMessages.push(result.stdout);
    }
  }

  return {
    exitCode: 0,
    processed: false,
    stdout: idleMessages.join("\n\n"),
  };
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
  const identity = resolveLocalIdentity();
  input.localState?.registerAgent?.(identity.defaultAgent);
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

    if (hasCancelRequest(issueResult.value, input.label)) {
      continue;
    }

    const candidateAgentIds = getCandidateAgentIds({
      labels: issueResult.value.labels,
      machineId: identity.machineId,
    });

    if (candidateAgentIds.length === 0) {
      continue;
    }

    for (const agentId of candidateAgentIds) {
      if (input.localState?.hasExecutionLock?.({
        repository: input.repository,
        issueNumber: summary.reference.number,
        agentId,
      })) {
        continue;
      }

      const issueActivity = getIssueActivity(issueResult.value);
      const handledCursor = input.localState?.readHandledCursor?.({
        repository: input.repository,
        issueNumber: summary.reference.number,
        agentId,
      });

      if (handledCursor !== undefined && isHandledCursorCovered(handledCursor, issueActivity)) {
        continue;
      }

      return claimAndRun({
        ...input,
        issueReference: summary.reference,
        workerId: agentId,
        issueActivity,
        now,
        issueRunner,
      });
    }
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
  issueActivity: IssueActivity;
  now: () => Date;
  issueRunner: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
}): Promise<DaemonCycleResult> {
  const executionLockResult = input.localState?.acquireExecutionLock?.({
    repository: input.repository,
    issueNumber: input.issueReference.number,
    agentId: input.workerId,
    now: input.now(),
  });

  if (executionLockResult !== undefined && !executionLockResult.ok) {
    return {
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        `Skipped ${formatIssueReference(input.issueReference)} because local execution is already active for ${input.workerId}.`,
      ].join("\n"),
    };
  }

  const claimResult = createIssueClaim({
    github: input.github,
    issueReference: input.issueReference,
    actor: "daemon",
    workerId: input.workerId,
    now: input.now(),
  });

  if (!claimResult.ok) {
    releaseExecutionLock(input, executionLockResult?.lock);

    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: claimResult.message,
    });
  }

  const rereadResult = input.github.readIssue(input.issueReference);

  if (!rereadResult.ok) {
    releaseExecutionLock(input, executionLockResult?.lock);

    return Promise.resolve({
      exitCode: 1,
      processed: false,
      stderr: rereadResult.error.message,
    });
  }

  const rereadIssue = rereadResult.value;

  if (hasCancelRequest(rereadIssue, input.label)) {
    updateIssueClaim(
      input.github,
      claimResult.claim,
      "released",
      input.now(),
      "Session canceled before runtime start.",
    );
    releaseExecutionLock(input, executionLockResult?.lock);

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

  updateIssueClaim(input.github, claimResult.claim, "active", input.now());

  try {
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
          updateIssueClaim(input.github, claimResult.claim, "active", input.now());
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
      "released",
      input.now(),
      result.canceled === true
        ? "Session canceled."
        : result.exitCode === 0
          ? "Session succeeded."
          : "Session failed. See the Grovie result comment and local run logs.",
    );

    input.localState?.writeHandledCursor?.({
      repository: input.repository,
      issueNumber: input.issueReference.number,
      agentId: input.workerId,
      handledThrough: input.issueActivity.timestamp,
      issueFingerprint: input.issueActivity.issueFingerprint,
      now: input.now(),
    });

    return {
      ...result,
      processed: true,
    };
  } finally {
    releaseExecutionLock(input, executionLockResult?.lock);
  }
}

function getCandidateAgentIds(input: {
  labels: string[];
  machineId: string;
}): string[] {
  const assignedAgentIds = getAssignedAgentIds(input.labels);

  if (assignedAgentIds.length === 0) {
    return [];
  }

  if (!isAssignedToLocalMachine(input.labels, input.machineId)) {
    return [];
  }

  return assignedAgentIds.filter((agentId) => agentId.endsWith(`@${input.machineId}`));
}

function isHandledCursorCovered(
  cursor: { handledThrough: string; issueFingerprint?: string },
  activity: IssueActivity,
): boolean {
  return (
    Date.parse(cursor.handledThrough) >= Date.parse(activity.timestamp) &&
    (cursor.issueFingerprint === undefined || cursor.issueFingerprint === activity.issueFingerprint)
  );
}

function getIssueActivity(issue: GitHubIssue): IssueActivity {
  const latestGrovieActivity = issue.comments
    .filter((comment) => isGrovieActivityComment(comment.body))
    .map((comment) => comment.updatedAt)
    .filter((timestamp) => !Number.isNaN(Date.parse(timestamp)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const issueUpdatedAt =
    latestGrovieActivity === undefined || Date.parse(issue.updatedAt) > Date.parse(latestGrovieActivity)
      ? [issue.updatedAt]
      : [];
  const timestamps = [
    ...issueUpdatedAt,
    ...issue.comments
      .filter((comment) => !isGrovieActivityComment(comment.body))
      .map((comment) => comment.updatedAt),
  ].filter((timestamp) => !Number.isNaN(Date.parse(timestamp)));

  if (timestamps.length === 0) {
    return {
      timestamp: "1970-01-01T00:00:00.000Z",
      issueFingerprint: getIssueFingerprint(issue),
    };
  }

  return {
    timestamp: timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "1970-01-01T00:00:00.000Z",
    issueFingerprint: getIssueFingerprint(issue),
  };
}

function isGrovieActivityComment(body: string): boolean {
  return body.includes("<!-- grovie:claim ") || body.includes("<!-- grovie:session ");
}

function getIssueFingerprint(issue: GitHubIssue): string {
  return createHash("sha256")
    .update(JSON.stringify({
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [...issue.labels].sort(),
    }))
    .digest("hex");
}

function acquireDaemonLock(input: Pick<DaemonInput, "localState" | "now">) {
  const identity = resolveLocalIdentity();
  return input.localState?.acquireDaemonLock?.(identity.machineId, input.now?.() ?? new Date()) ?? {
    ok: true as const,
    lock: undefined,
  };
}

function releaseDaemonLock(input: Pick<DaemonInput, "localState">, lock: DaemonLock | undefined): void {
  if (lock !== undefined) {
    input.localState?.releaseDaemonLock?.(lock);
  }
}

function releaseExecutionLock(input: Pick<DaemonInput, "localState">, lock: ExecutionLock | undefined): void {
  if (lock !== undefined) {
    input.localState?.releaseExecutionLock?.(lock);
  }
}

function sleepSync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
