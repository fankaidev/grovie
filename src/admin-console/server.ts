import { createServer, type Server } from "node:http";
import { serveAdminWebAsset } from "./assets.js";
import type { AdminApiCancelRunResponse, AdminApiErrorResponse, AdminConsoleRootHealthResponse } from "../admin-api.js";
import { writeRunCancellation } from "../local-state.js";
import { findLocalRun } from "../status.js";
import { handleAdminApiGet } from "./server/api.js";
import { resolveAdminConsoleConfig } from "./server/config.js";
import { writeHtml, writeJson, parseRequestUrl } from "./server/http.js";
import { renderAdminHome, renderNotFoundPage, renderRunDetailPage } from "./server/pages.js";
import { isCancelableRun } from "./server/run-data.js";
import type { AdminConsoleContext, AdminConsoleResolvedConfig, StartedAdminConsole } from "./server/types.js";

export type { AdminConsoleContext, AdminConsoleResolvedConfig, AdminConsoleServerHandle, StartedAdminConsole } from "./server/types.js";
export { resolveAdminConsoleConfig } from "./server/config.js";

export function createAdminConsoleServer(context?: AdminConsoleContext): Server {
  return createServer((request, response) => {
    const url = parseRequestUrl(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const body: AdminConsoleRootHealthResponse = {
        ok: true,
        service: "grovie-admin-console",
      };
      writeJson(response, 200, body);
      return;
    }

    if (context !== undefined && request.method === "POST") {
      const cancelMatch = /^\/api\/runs\/(?<runId>[^/]+)\/cancel$/.exec(url.pathname);

      if (cancelMatch?.groups?.runId !== undefined) {
        const runId = decodeURIComponent(cancelMatch.groups.runId);
        const run = findLocalRun(context.paths.runsDir, runId);

        if (run === undefined) {
          const body: AdminApiErrorResponse = {
            error: "not_found",
            message: "Run not found.",
          };
          writeJson(response, 404, body);
          return;
        }

        if (!isCancelableRun(run)) {
          const body: AdminApiErrorResponse = {
            error: "not_cancelable",
            message: `Run ${run.runId} is ${run.status}; only active local runs can be canceled.`,
          };
          writeJson(response, 409, body);
          return;
        }

        const cancellation = writeRunCancellation(context.paths, {
          runId,
          reason: "Canceled from local admin console.",
        });

        const body: AdminApiCancelRunResponse = {
          ok: true,
          cancellation,
        };
        writeJson(response, 202, body);
        return;
      }
    }

    if (context !== undefined && request.method === "GET") {
      if (url.pathname.startsWith("/api/")) {
        return handleAdminApiGet(context, request, url, response);
      }

      if (serveAdminWebAsset(context, url, response)) {
        return;
      }

      if (url.pathname === "/") {
        writeHtml(response, 200, renderAdminHome(context));
        return;
      }

      const runPageMatch = /^\/runs\/(?<runId>[^/]+)$/.exec(url.pathname);

      if (runPageMatch?.groups?.runId !== undefined) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runPageMatch.groups.runId));

        if (run === undefined) {
          writeHtml(response, 404, renderNotFoundPage("Run not found."));
          return;
        }

        writeHtml(response, 200, renderRunDetailPage(run));
        return;
      }

      const sessionPageMatch = /^\/sessions\/(?<sessionId>[^/]+)$/.exec(url.pathname);

      if (sessionPageMatch?.groups?.sessionId !== undefined) {
        writeHtml(response, 200, renderAdminHome(context));
        return;
      }

    }

    const body: AdminApiErrorResponse = {
      error: "not_found",
      message: "Admin console endpoint not found.",
    };
    writeJson(response, 404, body);
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
