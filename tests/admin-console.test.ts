import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdminConsoleServer,
  resolveAdminConsoleConfig,
  startAdminConsoleServer,
  type StartedAdminConsole,
} from "../src/admin-console.js";

const servers: StartedAdminConsole[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => new Promise<void>((resolve) => {
    started.server.close(() => resolve());
  })));
});

describe("admin console server", () => {
  it("[UC-ADMIN-01-S02] resolves the enabled local admin console default bind address and port", () => {
    expect(resolveAdminConsoleConfig({
      version: 1,
      watchedRepositories: [],
      adminConsole: {
        enabled: true,
      },
    })).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 8765,
    });
  });

  it("[UC-ADMIN-01-S03] starts on an explicitly configured local port", async () => {
    const port = await getAvailablePort();
    const started = await startAdminConsoleServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      server: createAdminConsoleServer(),
    });
    servers.push(started);

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "grovie-admin-console",
    });
  });

  it("[UC-ADMIN-01-S04] fails clearly when the configured port is unavailable", async () => {
    const port = await getAvailablePort();
    const occupied = await startAdminConsoleServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      server: createAdminConsoleServer(),
    });
    servers.push(occupied);

    await expect(startAdminConsoleServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      server: createServer(),
    })).rejects.toThrow(`Admin console port ${port} is unavailable on 127.0.0.1.`);
  });
});

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}
