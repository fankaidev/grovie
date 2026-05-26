import type { RunIssueResult } from "../run.js";
import { planRepositoryEventPolling } from "../repository-events.js";
import { recordActivity } from "./activity.js";
import { runDaemonCycle } from "./cycle.js";
import type { DaemonCycleResult, DaemonInput, MultiRepositoryDaemonInput } from "./types.js";

export async function runDaemonSingleRepositoryCycle(input: DaemonInput): Promise<DaemonCycleResult> {
  recordActivity(input, {
    type: "repository.poll_started",
    message: `Polling ${input.repository}.`,
    repository: input.repository,
    data: {
      label: input.label,
    },
  });

  const eventPlan = planRepositoryCycle(input, input.repository);

  recordActivity(input, {
    type: `repository.events_${eventPlan.mode}`,
    message: `${input.repository}: ${eventPlan.reason}.`,
    repository: input.repository,
    data: {
      eventCount: eventPlan.eventCount,
      issueNumbers: eventPlan.issueNumbers,
    },
  });

  if (eventPlan.mode === "skip") {
    return {
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        `Skipped ${input.repository}: ${eventPlan.reason}.`,
      ].join("\n"),
    };
  }

  return runDaemonCycle({
    ...input,
    issueNumbers: eventPlan.issueNumbers,
  });
}

export async function runDaemonRepositoryCycle(input: MultiRepositoryDaemonInput): Promise<DaemonCycleResult> {
  const idleMessages: string[] = [];

  for (const repository of input.repositories) {
    recordActivity(input, {
      type: "repository.poll_started",
      message: `Polling ${repository.repository}.`,
      repository: repository.repository,
      data: {
        label: repository.label,
      },
    });

    const config = repository.config ?? input.config;
    const eventPlan = planRepositoryCycle(input, repository.repository);

    recordActivity(input, {
      type: `repository.events_${eventPlan.mode}`,
      message: `${repository.repository}: ${eventPlan.reason}.`,
      repository: repository.repository,
      data: {
        eventCount: eventPlan.eventCount,
        issueNumbers: eventPlan.issueNumbers,
      },
    });

    if (eventPlan.mode === "skip") {
      idleMessages.push([
        "grovie daemon",
        "",
        `Skipped ${repository.repository}: ${eventPlan.reason}.`,
      ].join("\n"));
      continue;
    }

    const result = await runDaemonCycle({
      ...input,
      repository: repository.repository,
      label: repository.label ?? config.queue.label,
      config,
      configPath: repository.configPath ?? input.configPath,
      issueNumbers: eventPlan.issueNumbers,
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
    stdout: idleMessages.join("\n\n") || undefined,
  };
}

export function toRunIssueResult(result: DaemonCycleResult): RunIssueResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function planRepositoryCycle(input: Pick<DaemonInput, "once" | "github" | "localState" | "now">, repository: string) {
  if (input.once || input.github.listRepositoryEvents === undefined) {
    return {
      mode: "full-scan" as const,
      reason: input.once ? "one-shot daemon run uses a full scan" : "GitHub repository events are unavailable",
      eventCount: 0,
    };
  }

  const eventsResult = input.github.listRepositoryEvents(repository);

  if (!eventsResult.ok) {
    return {
      mode: "full-scan" as const,
      reason: `repository events failed: ${eventsResult.error.message}`,
      eventCount: 0,
    };
  }

  return planRepositoryEventPolling({
    paths: input.localState?.getPaths?.(),
    repository,
    events: eventsResult.value,
    github: input.github,
    now: input.now?.(),
  });
}
