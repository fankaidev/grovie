import type { StartedAdminConsole } from "./admin-console.js";
import { startDaemonAdminConsole, stopDaemonAdminConsole } from "./daemon/admin-console.js";
import { runDaemonCycle } from "./daemon/cycle.js";
import { acquireDaemonLock, releaseDaemonLock, validateLocalAgents } from "./daemon/locks.js";
import { runDaemonRepositoryCycle, runDaemonSingleRepositoryCycle, toRunIssueResult } from "./daemon/repository-cycle.js";
import type { DaemonInput, MultiRepositoryDaemonInput } from "./daemon/types.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./daemon/types.js";
import type { RunIssueResult } from "./run.js";

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

    while (true) {
      const result = await runDaemonSingleRepositoryCycle(input);
      await reportDaemonCycle(input, result);
      const sleep = input.sleep ?? sleepSync;
      await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
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
      stderr: "No watched repositories configured. Add one with `grovie watch add owner/repo`.",
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
      while (true) {
        const result = await runDaemonRepositoryCycle(input);
        await reportDaemonCycle(input, result);
        const sleep = input.sleep ?? sleepSync;
        await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
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
