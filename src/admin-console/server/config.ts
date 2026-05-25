import type { GlobalGrovieConfig } from "../../config.js";
import type { AdminConsoleResolvedConfig } from "./types.js";

const DEFAULT_ADMIN_CONSOLE_PORT = 8765;

export function resolveAdminConsoleConfig(config: GlobalGrovieConfig): AdminConsoleResolvedConfig {
  return {
    enabled: config.adminConsole?.enabled ?? false,
    host: config.adminConsole?.host ?? "127.0.0.1",
    port: config.adminConsole?.port ?? DEFAULT_ADMIN_CONSOLE_PORT,
  };
}
