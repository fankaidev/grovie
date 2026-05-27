import type { StartedAdminConsole } from "./admin-console.js";
import { startDaemonAdminConsole, stopDaemonAdminConsole } from "./daemon/admin-console.js";
import { runDaemonCycle } from "./daemon/cycle.js";
import { acquireDaemonLock, releaseDaemonLock, validateLocalAgents } from "./daemon/locks.js";
import { runDaemonRepositoryCycle, runDaemonSingleRepositoryCycle, toRunIssueResult } from "./daemon/repository-cycle.js";
import type { DaemonInput, MultiRepositoryDaemonInput } from "./daemon/types.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./daemon/types.js";
import type { IssueRefreshRequest, RunIssueResult } from "./run.js";

export type { DaemonCycleResult, DaemonInput, DaemonRepositoryInput, MultiRepositoryDaemonInput } from "./daemon/types.js";
export { NO_LOCAL_AGENTS_MESSAGE } from "./daemon/types.js";
export { runDaemonCycle } from "./daemon/cycle.js";

export async function runDaemon(input: DaemonInput): Promise<RunIssueResult> {
  const localAgentError = validateLocalAgents(input);

  if (localAgentError !== undefined) {
    return localAgentError;
  }

  const daemonLockResult = acquireDaemonLock(input);

  if (!daemonLockResult.ok) {
    return {
      exitCode: 1,
      stderr: daemonLockResult.message,
    };
  }

  let adminConsole: StartedAdminConsole | undefined;

  try {
    adminConsole = await startDaemonAdminConsole(input);
  } catch (error) {
    releaseDaemonLock(input, daemonLockResult.lock);

    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (input.once) {
      return toRunIssueResult(await runDaemonCycle(input));
    }

    const refreshQueue = new IssueRefreshQueue();

    while (true) {
      const pendingIssueNumbers = refreshQueue.takeRepository(input.repository);
      const result = pendingIssueNumbers.length === 0
        ? await runDaemonSingleRepositoryCycle(input)
        : await runDaemonCycle({
          ...input,
          issueNumbers: pendingIssueNumbers,
        });
      refreshQueue.enqueue(result.refreshes);
      await reportDaemonCycle(input, result);

      if (!refreshQueue.hasPending()) {
        const sleep = input.sleep ?? sleepSync;
        await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      }
    }
  } finally {
    await stopDaemonAdminConsole(adminConsole);
    releaseDaemonLock(input, daemonLockResult.lock);
  }
}

export async function runDaemonForRepositories(input: MultiRepositoryDaemonInput): Promise<RunIssueResult> {
  const localAgentError = validateLocalAgents(input);

  if (localAgentError !== undefined) {
    return localAgentError;
  }

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
      stderr: "No watched repositories configured. Edit watchedRepositories in ~/.grovie/config.yml.",
    };
  }

  let adminConsole: StartedAdminConsole | undefined;

  try {
    adminConsole = await startDaemonAdminConsole(input);
  } catch (error) {
    releaseDaemonLock(input, daemonLockResult.lock);

    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (!input.once) {
      const refreshQueue = new IssueRefreshQueue();

      while (true) {
        const pendingRepositories = applyPendingRepositoryRefreshes(input.repositories, refreshQueue.takeAll());
        const result = await runDaemonRepositoryCycle({
          ...input,
          repositories: pendingRepositories,
        });
        refreshQueue.enqueue(result.refreshes);
        await reportDaemonCycle(input, result);

        if (!refreshQueue.hasPending()) {
          const sleep = input.sleep ?? sleepSync;
          await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        }
      }
    }

    return toRunIssueResult(await runDaemonRepositoryCycle(input));
  } finally {
    await stopDaemonAdminConsole(adminConsole);
    releaseDaemonLock(input, daemonLockResult.lock);
  }
}

async function reportDaemonCycle(input: Pick<DaemonInput, "onCycleResult">, result: RunIssueResult): Promise<void> {
  if (input.onCycleResult !== undefined) {
    await input.onCycleResult(result);
    return;
  }

  if (result.stderr !== undefined && result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
}

function sleepSync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class IssueRefreshQueue {
  private readonly pending = new Map<string, Set<number>>();

  enqueue(refreshes: IssueRefreshRequest[] | undefined): void {
    for (const refresh of refreshes ?? []) {
      const issues = this.pending.get(refresh.repository) ?? new Set<number>();
      issues.add(refresh.issueNumber);
      this.pending.set(refresh.repository, issues);
    }
  }

  takeRepository(repository: string): number[] {
    const issues = this.pending.get(repository);

    if (issues === undefined) {
      return [];
    }

    this.pending.delete(repository);
    return [...issues].sort((left, right) => left - right);
  }

  takeAll(): Map<string, number[]> {
    const entries = new Map<string, number[]>();

    for (const [repository, issues] of this.pending) {
      entries.set(repository, [...issues].sort((left, right) => left - right));
    }

    this.pending.clear();
    return entries;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}

function applyPendingRepositoryRefreshes(
  repositories: MultiRepositoryDaemonInput["repositories"],
  pending: Map<string, number[]>,
): MultiRepositoryDaemonInput["repositories"] {
  if (pending.size === 0) {
    return repositories;
  }

  return repositories
    .filter((repository) => pending.has(repository.repository))
    .map((repository) => ({
      ...repository,
      issueNumbers: pending.get(repository.repository),
    }));
}
