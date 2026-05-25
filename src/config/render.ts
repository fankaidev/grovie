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
  const agents = config.agents.length === 0
    ? "agents: []"
    : [
      "agents:",
      config.agents
        .map((agent) => {
          const lines = [
            `  - name: ${agent.name}`,
            `    runtime: ${agent.runtime}`,
          ];

          if (agent.instructions !== undefined) {
            lines.push(`    instructions: ${agent.instructions}`);
          }

          if (agent.model !== undefined) {
            lines.push(`    model: ${agent.model}`);
          }

          if (agent.args.length > 0) {
            lines.push("    args:");
            lines.push(...agent.args.map((arg) => `      - ${arg}`));
          }

          if (agent.envKeys.length > 0) {
            lines.push("    envKeys:");
            lines.push(...agent.envKeys.map((envKey) => `      - ${envKey}`));
          }

          return lines.join("\n");
        })
        .join("\n"),
    ].join("\n");
  const watchedRepositories = config.watchedRepositories.length === 0
    ? "watchedRepositories: []"
    : [
      "watchedRepositories:",
      config.watchedRepositories
        .map((watchedRepository) => {
          const lines = [`  - repository: ${watchedRepository.repository}`];

          if (watchedRepository.label !== undefined) {
            lines.push(`    label: ${watchedRepository.label}`);
          }

          return lines.join("\n");
        })
        .join("\n"),
    ].join("\n");

  const stateRepo = config.stateRepo === undefined
    ? ""
    : [
      "stateRepo:",
      `  enabled: ${config.stateRepo.enabled}`,
      `  repository: ${config.stateRepo.repository}`,
      `  branch: ${config.stateRepo.branch}`,
      ...(config.stateRepo.localPath === undefined ? [] : [`  localPath: ${config.stateRepo.localPath}`]),
      `  syncIntervalSeconds: ${config.stateRepo.syncIntervalSeconds}`,
      "",
    ].join("\n");

  return `# Grovie global worker configuration.
# This file schedules repositories for the local daemon. It is not a security allowlist.
version: 1
${agents}
${watchedRepositories}
${stateRepo}# Optional state repo sync is for observability and recovery only.
# Redaction is best-effort and is not a security boundary.
adminConsole:
  enabled: ${config.adminConsole?.enabled ?? false}
${config.adminConsole?.host === undefined ? "" : `  host: ${config.adminConsole.host}\n`}${config.adminConsole?.port === undefined ? "" : `  port: ${config.adminConsole.port}\n`}`;
}
