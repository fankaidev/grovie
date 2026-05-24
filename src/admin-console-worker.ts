import { parentPort, workerData } from "node:worker_threads";
import {
  createAdminConsoleServer,
  startAdminConsoleServer,
  type AdminConsoleResolvedConfig,
} from "./admin-console.js";
import { LocalDaemonLifecycle } from "./daemon-lifecycle.js";
import type { LocalStatePaths } from "./local-state.js";
import { createRuntime, type RuntimeName } from "./runtime.js";

type AdminConsoleWorkerData = {
  config: AdminConsoleResolvedConfig;
  paths: LocalStatePaths;
  runtimeName: RuntimeName;
};

const data = workerData as AdminConsoleWorkerData;
const started = await startAdminConsoleServer({
  config: data.config,
  server: createAdminConsoleServer({
    paths: data.paths,
    daemonLifecycle: new LocalDaemonLifecycle(),
    runtime: createRuntime(data.runtimeName),
  }),
}).catch((error: unknown) => {
  parentPort?.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
});

parentPort?.postMessage({
  type: "started",
  url: started.url,
});

parentPort?.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "stop"
  ) {
    started.server.closeAllConnections();
    started.server.close(() => {
      process.exit(0);
    });
  }
});
