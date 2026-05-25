import type { RunIssueAsyncInput, RunIssueResult } from "../run.js";
import { recordActivity } from "./activity.js";
import { runRequestedIssue } from "./issue-execution.js";
import { isConfiguredLocalAgent } from "./locks.js";
import type { DaemonCycleResult, DaemonInput } from "./types.js";

export async function runRequestedLocalWork(input: DaemonInput & {
  now: () => Date;
  issueRunner: (input: RunIssueAsyncInput) => RunIssueResult | Promise<RunIssueResult>;
}): Promise<DaemonCycleResult | undefined> {
  const resumableRun = input.localState?.takeResumableRun?.({
    repository: input.repository,
    now: input.now(),
  });

  if (resumableRun !== undefined) {
    recordActivity(input, {
      type: "run.resume_detected",
      message: `Found resumable run ${resumableRun.runId} for ${input.repository}#${resumableRun.issueNumber}.`,
      repository: input.repository,
      issueNumber: resumableRun.issueNumber,
      agentId: resumableRun.agentId,
      data: {
        runId: resumableRun.runId,
        status: resumableRun.status,
      },
    });

    if (!isConfiguredLocalAgent(input, resumableRun.agentId)) {
      const reason = `Agent ${resumableRun.agentId} is not configured locally.`;
      input.localState?.markRunRejected?.({
        runId: resumableRun.runId,
        now: input.now(),
        reason,
      });

      recordActivity(input, {
        type: "run.resume_rejected",
        message: `Rejected resumable run ${resumableRun.runId}: ${reason}`,
        repository: input.repository,
        issueNumber: resumableRun.issueNumber,
        agentId: resumableRun.agentId,
        data: {
          runId: resumableRun.runId,
        },
      });

      return {
        exitCode: 0,
        processed: true,
        stdout: [
          "grovie daemon",
          "",
          `Skipped resumable run ${resumableRun.runId} for ${input.repository}#${resumableRun.issueNumber}: ${reason}`,
        ].join("\n"),
      };
    }

    const result = await runRequestedIssue({
      ...input,
      issueNumber: resumableRun.issueNumber,
      workerId: resumableRun.agentId,
      runRequest: {
        sourceRunId: resumableRun.runId,
        reason: "resume",
      },
    });

    if (result.processed) {
      input.localState?.markSessionResuming?.({
        sourceRunId: resumableRun.runId,
        now: input.now(),
        reason: "daemon restart recovery",
      });
    }

    return result;
  }

  const request = input.localState?.takeRunRequest?.(input.repository);

  if (request === undefined) {
    return undefined;
  }

  recordActivity(input, {
    type: "run.request_received",
    message: `Received ${request.reason ?? "manual"} run request ${request.id} for ${input.repository}#${request.issueNumber}.`,
    repository: input.repository,
    issueNumber: request.issueNumber,
    agentId: request.agentId,
    data: {
      requestId: request.id,
      reason: request.reason,
      sourceRunId: request.sourceRunId,
    },
  });

  if (!isConfiguredLocalAgent(input, request.agentId)) {
    const reason = `Agent ${request.agentId} is not configured locally.`;

    if (request.sourceRunId !== undefined) {
      input.localState?.markRunRejected?.({
        runId: request.sourceRunId,
        now: input.now(),
        reason,
      });
    }

    recordActivity(input, {
      type: "run.request_rejected",
      message: `Rejected run request ${request.id}: ${reason}`,
      repository: input.repository,
      issueNumber: request.issueNumber,
      agentId: request.agentId,
      data: {
        requestId: request.id,
      },
    });

    return {
      exitCode: 0,
      processed: true,
      stdout: [
        "grovie daemon",
        "",
        `Rejected run request ${request.id} for ${input.repository}#${request.issueNumber}: ${reason}`,
      ].join("\n"),
    };
  }

  return runRequestedIssue({
    ...input,
    issueNumber: request.issueNumber,
    workerId: request.agentId,
    runRequest: {
      sourceRunId: request.sourceRunId,
      reason: request.reason,
    },
  });
}
