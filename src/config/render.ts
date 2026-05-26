import { stringify } from "yaml";
import type { GlobalGrovieConfig } from "../config.js";

export function renderGlobalConfig(config: GlobalGrovieConfig): string {
  const renderedConfig = stringify({
    ...config,
    adminConsole: {
      enabled: config.adminConsole?.enabled ?? false,
      ...(config.adminConsole?.host === undefined ? {} : { host: config.adminConsole.host }),
      ...(config.adminConsole?.port === undefined ? {} : { port: config.adminConsole.port }),
    },
  });

  return `# Grovie global configuration.
# This file schedules repositories for the local daemon. It is not a security allowlist.
${renderedConfig.replace(/^stateRepo:/m, [
    "# Optional state repo sync is for observability and recovery only.",
    "stateRepo:",
  ].join("\n")).replace(/^adminConsole:/m, [
    "# Redaction is best-effort and is not a security boundary.",
    "adminConsole:",
  ].join("\n"))}`;
}
