import { createServer, type Server, type ServerResponse } from "node:http";
import type { GlobalGrovieConfig } from "./config.js";

export type AdminConsoleResolvedConfig = {
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
};

export type StartedAdminConsole = {
  server: Server;
  url: string;
};

const DEFAULT_ADMIN_CONSOLE_PORT = 8765;

export function resolveAdminConsoleConfig(config: GlobalGrovieConfig): AdminConsoleResolvedConfig {
  return {
    enabled: config.adminConsole?.enabled ?? false,
    host: config.adminConsole?.host ?? "127.0.0.1",
    port: config.adminConsole?.port ?? DEFAULT_ADMIN_CONSOLE_PORT,
  };
}

export function createAdminConsoleServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "grovie-admin-console",
      });
      return;
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
