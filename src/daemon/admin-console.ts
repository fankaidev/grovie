import {
  createAdminConsoleServer,
  resolveAdminConsoleConfig,
  startAdminConsoleServer,
  startAdminConsoleWorker,
  type StartedAdminConsole,
} from "../admin-console.js";
import { LocalDaemonLifecycle } from "../daemon-lifecycle.js";
import type { DaemonInput, MultiRepositoryDaemonInput } from "./types.js";

export async function startDaemonAdminConsole(input: MultiRepositoryDaemonInput | DaemonInput): Promise<StartedAdminConsole | undefined> {
  const config = input.adminConsole ?? resolveAdminConsoleConfig({
    version: 1,
    agents: [],
    watchedRepositories: [],
    adminConsole: {
      enabled: false,
    },
  });

  if (!config.enabled) {
    return undefined;
  }

  if (input.localState === undefined) {
    throw new Error("Admin console requires local daemon state.");
  }

  const daemonLifecycle = input.daemonLifecycle ?? new LocalDaemonLifecycle();

  if (!input.once) {
    return startAdminConsoleWorker({
      config,
      paths: input.localState.getPaths(),
    });
  }

  return startAdminConsoleServer({
    config,
    server: createAdminConsoleServer({
      paths: input.localState.getPaths(),
      daemonLifecycle,
    }),
  });
}

export async function stopDaemonAdminConsole(started: StartedAdminConsole | undefined): Promise<void> {
  if (started === undefined) {
    return;
  }

  started.server.closeAllConnections();

  await new Promise<void>((resolve, reject) => {
    started.server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}
