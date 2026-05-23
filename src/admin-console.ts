import { createServer, type Server, type ServerResponse } from "node:http";
import { loadGlobalConfig, type GlobalGrovieConfig } from "./config.js";
import type { DaemonLifecycle } from "./daemon-lifecycle.js";
import type { LocalStatePaths } from "./local-state.js";
import type { AgentRuntime } from "./runtime.js";
import { findLocalRun, listLocalRuns } from "./status.js";

export type AdminConsoleResolvedConfig = {
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
};

export type StartedAdminConsole = {
  server: Server;
  url: string;
};

export type AdminConsoleContext = {
  paths: LocalStatePaths;
  daemonLifecycle: DaemonLifecycle;
  runtime: AgentRuntime;
};

const DEFAULT_ADMIN_CONSOLE_PORT = 8765;

export function resolveAdminConsoleConfig(config: GlobalGrovieConfig): AdminConsoleResolvedConfig {
  return {
    enabled: config.adminConsole?.enabled ?? false,
    host: config.adminConsole?.host ?? "127.0.0.1",
    port: config.adminConsole?.port ?? DEFAULT_ADMIN_CONSOLE_PORT,
  };
}

export function createAdminConsoleServer(context?: AdminConsoleContext): Server {
  return createServer((request, response) => {
    const url = parseRequestUrl(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "grovie-admin-console",
      });
      return;
    }

    if (context !== undefined && request.method === "GET") {
      if (url.pathname === "/api/health") {
        writeJson(response, 200, {
          ok: true,
          daemon: context.daemonLifecycle.status({ root: context.paths.root }),
          runtime: context.runtime.checkAvailability(),
        });
        return;
      }

      if (url.pathname === "/api/config") {
        const globalConfig = loadGlobalConfig(context.paths.root);

        writeJson(response, 200, {
          path: globalConfig.path,
          config: globalConfig.config,
        });
        return;
      }

      if (url.pathname === "/api/repos") {
        writeJson(response, 200, {
          repositories: loadGlobalConfig(context.paths.root).config.watchedRepositories,
        });
        return;
      }

      if (url.pathname === "/api/runs") {
        writeJson(response, 200, {
          runs: listLocalRuns(context.paths.runsDir),
        });
        return;
      }

      const runEventsMatch = /^\/api\/runs\/(?<runId>[^/]+)\/events$/.exec(url.pathname);

      if (runEventsMatch?.groups?.runId !== undefined) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runEventsMatch.groups.runId));

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        writeJson(response, 200, {
          runId: run.runId,
          events: run.events,
        });
        return;
      }

      const runMatch = /^\/api\/runs\/(?<runId>[^/]+)$/.exec(url.pathname);

      if (runMatch?.groups?.runId !== undefined) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runMatch.groups.runId));

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        writeJson(response, 200, {
          run,
        });
        return;
      }
    }

    writeJson(response, 404, {
      error: "not_found",
      message: "Admin console endpoint not found.",
    });
  });
}

export function startAdminConsoleServer(input: {
  config: AdminConsoleResolvedConfig;
  server?: Server;
}): Promise<StartedAdminConsole> {
  if (!input.config.enabled) {
    return Promise.reject(new Error("Admin console is disabled. Set adminConsole.enabled: true in the global config."));
  }

  const server = input.server ?? createAdminConsoleServer();

  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);

      if (error.code === "EADDRINUSE") {
        reject(new Error(`Admin console port ${input.config.port} is unavailable on ${input.config.host}.`));
        return;
      }

      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({
        server,
        url: `http://${input.config.host}:${input.config.port}`,
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.config.port, input.config.host);
  });
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function parseRequestUrl(url: string | undefined): URL {
  return new URL(url ?? "/", "http://127.0.0.1");
}
