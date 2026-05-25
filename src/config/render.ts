import { stringify } from "yaml";
import type { GlobalGrovieConfig } from "../config.js";

export function renderDefaultConfig(): string {
  return `# Grovie configuration.
# GitHub remains the source of truth; this file defines local runner policy.
version: 1

queue:
  label: grovie

branches:
  prefix: grovie/

pullRequests:
  create: true
  draft: false

comments:
  mode: concise

trust:
  # If empty or omitted, daemon queue runs trust only the authenticated gh user.
  trustedAuthors: []

safety:
  # This must stay false. Grovie should never push directly to the default branch.
  allowDefaultBranchPush: false
`;
}

export function renderGlobalConfig(config: GlobalGrovieConfig): string {
  const renderedConfig = stringify({
    ...config,
    adminConsole: {
      enabled: config.adminConsole?.enabled ?? false,
      ...(config.adminConsole?.host === undefined ? {} : { host: config.adminConsole.host }),
      ...(config.adminConsole?.port === undefined ? {} : { port: config.adminConsole.port }),
    },
  });

  return `# Grovie global worker configuration.
# This file schedules repositories for the local daemon. It is not a security allowlist.
${renderedConfig.replace(/^stateRepo:/m, [
    "# Optional state repo sync is for observability and recovery only.",
    "stateRepo:",
  ].join("\n")).replace(/^adminConsole:/m, [
    "# Redaction is best-effort and is not a security boundary.",
    "adminConsole:",
  ].join("\n"))}`;
}
