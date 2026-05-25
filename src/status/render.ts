import type { AgentHealth } from "../agent-health.js";
import type { WatchedRepository } from "../config.js";
import type { DaemonLifecycleStatus } from "../daemon-lifecycle.js";
import type { LocalRunSummary, LocalStatusOverviewInput, RunEvent } from "../status.js";

const RECENT_EVENT_LIMIT = 5;

export function renderRunsList(runs: LocalRunSummary[], title = "grovie runs list"): string {
  if (runs.length === 0) {
    return [title, "", "No local runs found."].join("\n");
  }

  return [
    title,
    "",
    ...runs.map((run) =>
      [
        `- ${run.runId}`,
        `  Status: ${run.status}`,
        `  Issue: ${renderIssue(run)}`,
        `  Agent: ${run.agentId ?? "(unknown)"}`,
        `  Runtime: ${run.runtime ?? "(unknown)"}`,
        `  Branch: ${run.branchName ?? "(unknown)"}`,
        `  Started: ${run.startedAt ?? "(unknown)"}`,
        `  Ended: ${run.endedAt ?? "(not ended)"}`,
        `  Result links: ${renderResultLinks(run)}`,
        `  Last event: ${renderLastEvent(run)}`,
        `  Logs: stdout=${run.stdoutPath} stderr=${run.stderrPath}`,
      ].join("\n"),
    ),
  ].join("\n");
}

export function renderRunDetail(run: LocalRunSummary): string {
  return [
    "grovie runs show",
    "",
    `Run id: ${run.runId}`,
    `Status: ${run.status}`,
    `Repository: ${run.repository ?? "(unknown)"}`,
    `Issue: ${run.issueNumber === undefined ? "(unknown)" : `#${run.issueNumber}`}`,
    `Agent: ${run.agentId ?? "(unknown)"}`,
    `Runtime: ${run.runtime ?? "(unknown)"}`,
    `Branch: ${run.branchName ?? "(unknown)"}`,
    `Local branch: ${run.localBranchName ?? "(unknown)"}`,
    `Worktree: ${run.worktreePath ?? "(unknown)"}`,
    `Run directory: ${run.runDir}`,
    `Stdout log: ${run.stdoutPath}`,
    `Stderr log: ${run.stderrPath}`,
    `Started: ${run.startedAt ?? "(unknown)"}`,
    `Ended: ${run.endedAt ?? "(not ended)"}`,
    `Result links: ${renderResultLinks(run)}`,
    `Last event: ${renderLastEvent(run)}`,
    "",
    "Recent events:",
    renderRecentEvents(run.events),
  ].join("\n");
}

export function renderLocalStatusOverview(input: LocalStatusOverviewInput): string {
  const activeRuns = input.runs.filter((run) =>
    run.status === "running"
    || run.status === "preparing"
    || run.status === "prepared"
    || run.status === "interrupting"
  );
  const recentFailures = input.runs.filter((run) => run.status === "failed" || run.status === "stale" || run.status === "interrupted" || run.status === "rejected").slice(0, 3);

  return [
    "grovie status",
    "",
    "Daemon:",
    `  Status: ${input.daemonStatus.status}`,
    ...renderDaemonStatusDetails(input.daemonStatus),
    "Admin console:",
    ...renderAdminConsoleStatus(input.adminConsole, input.daemonStatus),
    "Configured agents:",
    renderAgentHealth(input.agentHealth),
    "Watched repositories:",
    renderWatchedRepositories(input.watchedRepositories),
    "Paths:",
    `  State: ${input.paths.root}`,
    `  Runs: ${input.paths.runsDir}`,
    `  Worktrees: ${input.paths.worktreesDir}`,
    `  Repositories: ${input.paths.reposDir}`,
    "Active runs:",
    renderRunSection(activeRuns, "  No active runs."),
    "Recent failures:",
    renderRunSection(recentFailures, "  No recent failures."),
  ].join("\n");
}

function renderAgentHealth(agentHealth: AgentHealth[] | undefined): string {
  if (agentHealth === undefined) {
    return "  Not loaded.";
  }

  if (agentHealth.length === 0) {
    return "  none";
  }

  return agentHealth
    .map((agent) => `  - ${agent.agentId} runtime=${agent.runtime} command=${agent.availability.command} ${agent.availability.available ? "available" : "unavailable"}: ${agent.availability.message}`)
    .join("\n");
}

function renderAdminConsoleStatus(
  config: LocalStatusOverviewInput["adminConsole"],
  daemonStatus: DaemonLifecycleStatus,
): string[] {
  if (config === undefined || !config.enabled) {
    return ["  Enabled: false"];
  }

  const availability = daemonStatus.status === "running"
    ? "expected available while the daemon is running"
    : `not expected to be available while the daemon is ${daemonStatus.status}`;

  return [
    "  Enabled: true",
    `  URL: http://${config.host}:${config.port}`,
    `  Availability: ${availability}`,
  ];
}

function renderIssue(run: LocalRunSummary): string {
  if (run.repository === undefined && run.issueNumber === undefined) {
    return "(unknown)";
  }

  return `${run.repository ?? "(unknown)"}${run.issueNumber === undefined ? "" : `#${run.issueNumber}`}`;
}

function renderResultLinks(run: LocalRunSummary): string {
  return run.resultLinks.length === 0 ? "(none)" : run.resultLinks.join(", ");
}

function renderLastEvent(run: LocalRunSummary): string {
  if (run.lastEventTime === undefined && run.lastEventType === undefined) {
    return "(none)";
  }

  if (run.lastEventType === undefined) {
    return run.lastEventTime ?? "(none)";
  }

  if (run.lastEventTime === undefined) {
    return run.lastEventType;
  }

  return `${run.lastEventTime} ${run.lastEventType}`;
}

function renderRecentEvents(events: RunEvent[]): string {
  if (events.length === 0) {
    return "  (none)";
  }

  return events
    .slice(-RECENT_EVENT_LIMIT)
    .map((event) => `  - ${event.timestamp ?? "(no timestamp)"} ${event.type}${renderEventData(event.data)}`)
    .join("\n");
}

function renderDaemonStatusDetails(status: DaemonLifecycleStatus): string[] {
  if (status.status === "stopped") {
    return [`  Daemon directory: ${status.daemonDir}`];
  }

  return [
    `  Pid: ${status.state.pid}`,
    `  Started: ${status.state.startedAt}`,
    `  State: ${status.state.statePath}`,
    `  Logs: stdout=${status.state.stdoutPath} stderr=${status.state.stderrPath}`,
  ];
}

function renderWatchedRepositories(repositories: WatchedRepository[]): string {
  if (repositories.length === 0) {
    return "  No watched repositories configured.";
  }

  return repositories
    .map((repository) => `  - ${repository.repository}${repository.label === undefined ? "" : ` label=${repository.label}`}`)
    .join("\n");
}

function renderRunSection(runs: LocalRunSummary[], emptyMessage: string): string {
  if (runs.length === 0) {
    return emptyMessage;
  }

  return runs.map((run) => `  - ${run.runId} ${renderIssue(run)} status=${run.status} branch=${run.branchName ?? "(unknown)"} last=${renderLastEvent(run)}`).join("\n");
}

function renderEventData(data: Record<string, unknown> | undefined): string {
  if (data === undefined || Object.keys(data).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(data)}`;
}
