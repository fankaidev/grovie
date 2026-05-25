import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { LocalStatePaths } from "../local-state.js";
import type { AdminConsoleContext, AdminConsoleResolvedConfig, AdminConsoleServerHandle, StartedAdminConsole } from "./server.js";

export function startAdminConsoleWorker(input: {
  config: AdminConsoleResolvedConfig;
  paths: LocalStatePaths;
}): Promise<StartedAdminConsole> {
  if (!input.config.enabled) {
    return Promise.reject(new Error("Admin console is disabled. Set adminConsole.enabled: true in the global config."));
  }

  const workerOptions = resolveAdminConsoleWorkerOptions();
  const worker = new Worker(workerOptions.url, {
    execArgv: workerOptions.execArgv,
    workerData: input,
  });

  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message)) {
        return;
      }

      if (message.type === "started") {
        worker.off("error", onError);
        resolve({
          server: createWorkerServerHandle(worker),
          url: message.url,
        });
        return;
      }

      if (message.type === "error") {
        cleanup();
        reject(new Error(message.message));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();

      if (code !== 0) {
        reject(new Error(`Admin console worker exited with code ${code}.`));
      }
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function resolveAdminConsoleWorkerOptions(): { url: URL; execArgv: string[] } {
  const builtWorkerUrl = new URL("../admin-console-worker.js", import.meta.url);

  if (existsSync(fileURLToPath(builtWorkerUrl))) {
    return {
      url: builtWorkerUrl,
      execArgv: [],
    };
  }

  return {
    url: new URL("../admin-console-worker.ts", import.meta.url),
    execArgv: ["--import", "tsx"],
  };
}

function createWorkerServerHandle(worker: Worker): AdminConsoleServerHandle {
  return {
    closeAllConnections: () => {},
    close: (callback?: (error?: Error) => void) => {
      const onExit = () => {
        callback?.();
      };
      const onError = (error: Error) => {
        callback?.(error);
      };

      worker.once("exit", onExit);
      worker.once("error", onError);
      worker.postMessage({ type: "stop" });
      return undefined as unknown as Server;
    },
  };
}

function isWorkerMessage(value: unknown): value is { type: "started"; url: string } | { type: "error"; message: string } {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && (
      ((value as { type?: unknown; url?: unknown }).type === "started" && typeof (value as { url?: unknown }).url === "string")
      || ((value as { type?: unknown; message?: unknown }).type === "error" && typeof (value as { message?: unknown }).message === "string")
    )
  );
}
