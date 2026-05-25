import type { ReactNode } from "react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import type {
  AdminApiCancelRunResponse,
  AdminApiActivityResponse,
  AdminApiConfigResponse,
  AdminApiHealthResponse,
  AdminApiRepositoriesResponse,
  AdminApiErrorResponse,
  AdminApiRunDetailResponse,
  AdminApiRunEventsResponse,
  AdminApiRunFileResponse,
  AdminApiRunsResponse,
  AdminApiRunLogResponse,
  AdminApiRunLogTranscriptResponse,
  RuntimeTranscript,
  RuntimeTranscriptEntry,
  LocalRunSummary,
} from "../../src/admin-api.js";
import "./styles.css";

type AdminHomeData = {
  health: AdminApiHealthResponse;
  config: {
    path: AdminApiConfigResponse["path"];
  };
  repositories: AdminApiRepositoriesResponse["repositories"];
  activity: AdminApiActivityResponse["activity"];
  runs: LocalRunSummary[];
};

type AdminHomeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: AdminHomeData };

type RunDetailState =
  | { status: "loading" }
  | { status: "not-found"; message: string }
  | { status: "error"; message: string }
  | {
    status: "ready";
    run: LocalRunSummary;
    events: AdminApiRunEventsResponse["events"];
    stdout: AdminApiRunLogResponse;
    stderr: AdminApiRunLogResponse;
    stdoutTranscript: AdminApiRunLogTranscriptResponse;
    prompt: AdminApiRunFileResponse;
    task: AdminApiRunFileResponse;
  };

type SessionDetailState =
  | { status: "loading" }
  | { status: "not-found"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; session: SessionSummary };

type HandoffTab = "prompt" | "task" | "stdout" | "stderr" | "events";
type RunDetailReadyState = Extract<RunDetailState, { status: "ready" }>;

type TranscriptBlock =
  | { kind: "assistant"; entry: Extract<RuntimeTranscriptEntry, { kind: "assistant_message" }> }
  | { kind: "activity"; entries: RuntimeTranscriptEntry[] };

type RunGroup = {
  key: string;
  sessionId: string;
  issueLabel: string;
  agentLabel: string;
  latestRun: LocalRunSummary;
  runs: LocalRunSummary[];
  counts: Record<string, number>;
  activeCount: number;
  latestTime: string;
};

type SessionSummary = RunGroup;

const ACTIVE_RUN_STATUSES = new Set(["preparing", "prepared", "running", "interrupting", "stale"]);

export function App(): ReactNode {
  const route = useMemo(() => readRoute(window.location.pathname), []);

  if (route.name === "run-detail") {
    return <RunDetailPage runId={route.runId} />;
  }

  if (route.name === "session-detail") {
    return <SessionDetailPage sessionId={route.sessionId} />;
  }

  return <AdminHome />;
}

function AdminHome(): ReactNode {
  const [state, setState] = useState<AdminHomeState>({ status: "loading" });

  useEffect(() => {
    let canceled = false;

    loadAdminHome()
      .then((data) => {
        if (!canceled) {
          setState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <CenteredNotice title="Loading admin console" message="Fetching local daemon state." />;
  }

  if (state.status === "error") {
    return <CenteredNotice title="Admin console unavailable" message={state.message} />;
  }

  return <AdminHomeContent data={state.data} />;
}

export function AdminHomeContent(props: { data: AdminHomeData }): ReactNode {
  const daemon = props.data.health.daemon;
  const daemonState = "state" in daemon ? daemon.state : undefined;
  const runtimes = props.data.health.runtimes;
  const agents = props.data.health.agents;
  const runs = props.data.runs.slice(0, 20);
  const activity = props.data.activity.slice(0, 20);

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Local admin console</p>
          <h1>Grovie</h1>
        </div>
        <span className={`status-badge status-${daemon.status}`}>{daemon.status}</span>
      </header>

      <section className="summary-grid">
        <InfoPanel title="Daemon">
          <DescriptionList
            items={[
              ["Status", daemon.status],
              ["PID", daemonState?.pid === undefined ? "(none)" : String(daemonState.pid)],
              ["Started", daemonState?.startedAt ?? "(not running)"],
              ["State path", daemonState?.statePath ?? "(none)"],
            ]}
          />
        </InfoPanel>
        <InfoPanel title="Useful Paths">
          <DescriptionList
            mono
            items={[
              ["Global config", props.data.config.path],
              ["Daemon stdout", daemonState?.stdoutPath ?? "(not running)"],
              ["Daemon stderr", daemonState?.stderrPath ?? "(not running)"],
            ]}
          />
        </InfoPanel>
      </section>

      <InfoPanel title="Runtimes">
        <RuntimesTable runtimes={runtimes} />
      </InfoPanel>
      <InfoPanel title="Agents">
        <AgentsTable agents={agents} />
      </InfoPanel>
      <WatchedRepositoriesPanel repositories={props.data.repositories} />
      <RecentRunsPanel runs={runs} />
      <RecentActivityPanel activity={activity} />
    </main>
  );
}

function RuntimesTable(props: { runtimes: AdminApiHealthResponse["runtimes"] }): ReactNode {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Runtime</th>
          <th>Command</th>
          <th>Status</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {props.runtimes.map((runtime) => (
          <tr key={runtime.runtime}>
            <td>{runtime.runtime}</td>
            <td>{runtime.command}</td>
            <td>{runtime.available ? "available" : "unavailable"}</td>
            <td>{runtime.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentsTable(props: { agents: AdminApiHealthResponse["agents"] }): ReactNode {
  if (props.agents.length === 0) {
    return <p className="muted-copy">No local agents configured.</p>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Runtime</th>
          <th>Command</th>
          <th>Status</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {props.agents.map((agent) => (
          <tr key={agent.agentId}>
            <td>{agent.agentId}</td>
            <td>{agent.runtime}</td>
            <td>{agent.availability.command}</td>
            <td>{agent.availability.available ? "available" : "unavailable"}</td>
            <td>{agent.availability.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WatchedRepositoriesPanel(props: { repositories: AdminHomeData["repositories"] }): ReactNode {
  return (
    <InfoPanel title="Watched Repositories">
      {props.repositories.length === 0 ? (
        <p className="muted-copy">No watched repositories configured.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            {props.repositories.map((repository) => (
              <tr key={`${repository.repository}-${repository.label ?? ""}`}>
                <td>{repository.repository}</td>
                <td>{repository.label ?? "(default)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </InfoPanel>
  );
}

function RecentActivityPanel(props: { activity: AdminHomeData["activity"] }): ReactNode {
  return (
    <InfoPanel title="Recent Activity">
      {props.activity.length === 0 ? (
        <p className="muted-copy">No daemon activity recorded.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Repository</th>
              <th>Issue</th>
              <th>Agent</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {props.activity.map((entry, index) => (
              <tr key={`${entry.timestamp}-${entry.type}-${index}`}>
                <td>{entry.timestamp}</td>
                <td><code>{entry.type}</code></td>
                <td>{entry.repository ?? "(none)"}</td>
                <td>{entry.issueNumber === undefined ? "none" : `#${entry.issueNumber}`}</td>
                <td>{entry.agentId ?? "none"}</td>
                <td>{entry.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </InfoPanel>
  );
}

function RecentRunsPanel(props: { runs: LocalRunSummary[] }): ReactNode {
  const [agentFilter, setAgentFilter] = useState("all");
  const groups = groupRunsByIssueAndAgent(props.runs);
  const agents = Array.from(new Set(groups.map((group) => group.agentLabel))).sort();
  const filteredGroups = agentFilter === "all" ? groups : groups.filter((group) => group.agentLabel === agentFilter);

  return (
    <InfoPanel title="Recent Sessions">
      {groups.length === 0 ? (
        <p className="muted-copy">No local runs found.</p>
      ) : (
        <>
          <div className="filter-bar">
            <span>Agent</span>
            <div className="filter-tags" aria-label="Agent filter">
              <button type="button" className={agentFilter === "all" ? "active" : undefined} onClick={() => setAgentFilter("all")}>
                All agents
              </button>
              {agents.map((agent) => (
                <button key={agent} type="button" className={agentFilter === agent ? "active" : undefined} onClick={() => setAgentFilter(agent)}>
                  {agent}
                </button>
              ))}
            </div>
            <span>{filteredGroups.length} of {groups.length} sessions</span>
          </div>
          {filteredGroups.length === 0 ? (
            <p className="muted-copy">No sessions match this agent.</p>
          ) : (
            <div className="run-group-list">
              {filteredGroups.map((group) => (
            <details key={group.key} className="run-group">
              <summary>
                <div className="run-group-summary">
                  <div>
                    <strong><a href={`/sessions/${encodeURIComponent(group.sessionId)}`}>{group.issueLabel}</a></strong>
                    <p>{group.agentLabel} · {group.latestRun.runtime ?? "(unknown runtime)"}</p>
                  </div>
                  <div className="summary-actions">
                    <span className={`status-badge compact status-${group.latestRun.status}`}>{group.latestRun.status}</span>
                    <span className="summary-chevron" aria-hidden="true" />
                  </div>
                </div>
                <div className="run-group-meta">
                  <span>{renderRunGroupCounts(group)}</span>
                  <span>Branch: {group.latestRun.branchName ?? "(unknown)"}</span>
                  <span>Latest: {group.latestTime}</span>
                  <span>{renderRunReason(group.latestRun)}</span>
                </div>
              </summary>
              <table className="data-table run-group-table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Started</th>
                    <th>Ended</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {group.runs.map((run) => (
                    <tr key={run.runId}>
                      <td><a href={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</a></td>
                      <td><span className={`status-badge compact status-${run.status}`}>{run.status}</span></td>
                      <td>{renderRunReason(run)}</td>
                      <td>{run.startedAt ?? "(unknown)"}</td>
                      <td>{run.endedAt ?? "(not ended)"}</td>
                      <td>{renderRunResultLinks(run)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
              ))}
            </div>
          )}
        </>
      )}
    </InfoPanel>
  );
}

function groupRunsByIssueAndAgent(runs: LocalRunSummary[]): RunGroup[] {
  const groups = new Map<string, LocalRunSummary[]>();

  for (const run of runs) {
    const key = sessionIdForRun(run);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  return [...groups.entries()].map(([key, groupRuns]) => {
    const sortedRuns = [...groupRuns].sort(compareRunsByLatestTime);
    const latestRun = sortedRuns[0]!;
    const counts = countRunStatuses(sortedRuns);
    const activeCount = sortedRuns.filter((run) => isActiveRunStatus(run.status)).length;

    return {
      key,
      sessionId: key,
      issueLabel: renderIssueReference(latestRun),
      agentLabel: latestRun.agentId ?? "(unknown agent)",
      latestRun,
      runs: sortedRuns,
      counts,
      activeCount,
      latestTime: runSortTime(latestRun) ?? "(unknown)",
    };
  }).sort((left, right) => {
    if (left.activeCount !== right.activeCount) {
      return right.activeCount - left.activeCount;
    }

    return compareTimeStrings(right.latestTime, left.latestTime);
  });
}

function sessionIdForRun(run: LocalRunSummary): string {
  if (run.branchName?.startsWith("grovie/") === true) {
    return run.branchName.slice("grovie/".length);
  }

  return run.runId.replace(/-\d{8}T\d{6}Z$/, "");
}

function compareRunsByLatestTime(left: LocalRunSummary, right: LocalRunSummary): number {
  return compareTimeStrings(runSortTime(right), runSortTime(left));
}

function runSortTime(run: LocalRunSummary): string | undefined {
  return run.lastEventTime ?? run.endedAt ?? run.startedAt ?? run.createdAt;
}

function compareTimeStrings(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

function countRunStatuses(runs: LocalRunSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const run of runs) {
    counts[run.status] = (counts[run.status] ?? 0) + 1;
  }

  return counts;
}

function renderRunGroupCounts(group: RunGroup): string {
  const statusParts = ["running", "succeeded", "failed", "canceled"]
    .map((status) => `${group.counts[status] ?? 0} ${status}`)
    .filter((part) => !part.startsWith("0 "));

  return [`${group.runs.length} total`, ...statusParts].join(" · ");
}

function renderAgentSessionCommand(run: LocalRunSummary): string {
  const sessionId = run.runtimeSessionRef?.sessionId;

  if (sessionId === undefined) {
    return "No runtime session recorded for the latest run.";
  }

  if (run.runtime === "codex") {
    return `cd ${shellQuote(run.worktreePath ?? ".")} && codex --ask-for-approval never resume ${shellQuote(sessionId)}`;
  }

  if (run.runtime === "claude-code") {
    return `cd ${shellQuote(run.worktreePath ?? ".")} && claude --resume ${shellQuote(sessionId)}`;
  }

  if (run.runtime === "pi") {
    return `cd ${shellQuote(run.worktreePath ?? ".")} && pi resume ${shellQuote(sessionId)} -`;
  }

  return `${run.runtime ?? "agent"} session ${sessionId}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderRunResultLinks(run: LocalRunSummary): ReactNode {
  if (run.resultLinks.length === 0) {
    return "(none)";
  }

  return (
    <ul className="inline-link-list">
      {run.resultLinks.map((link, index) => (
        <li key={link}>
          <a href={link}>{renderResultLinkLabel(link, index)}</a>
        </li>
      ))}
    </ul>
  );
}

function renderResultLinkLabel(link: string, index: number): string {
  const pullRequestMatch = /\/pull\/(?<number>\d+)(?:$|[/?#])/.exec(link);

  if (pullRequestMatch?.groups?.number !== undefined) {
    return `PR #${pullRequestMatch.groups.number}`;
  }

  if (link.includes("/issues/") && link.includes("#issuecomment-")) {
    return "comment";
  }

  return `link ${index + 1}`;
}

function isActiveRunStatus(status: LocalRunSummary["status"]): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

function SessionDetailPage(props: { sessionId: string }): ReactNode {
  const [state, setState] = useState<SessionDetailState>({ status: "loading" });

  useEffect(() => {
    let canceled = false;

    loadSessionDetail(props.sessionId)
      .then((nextState) => {
        if (!canceled) {
          setState(nextState);
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [props.sessionId]);

  if (state.status === "loading") {
    return <CenteredNotice title="Loading session" message={`Fetching ${props.sessionId}.`} />;
  }

  if (state.status === "not-found") {
    return <CenteredNotice title="Session not found" message={state.message} />;
  }

  if (state.status === "error") {
    return <CenteredNotice title="Session detail unavailable" message={state.message} />;
  }

  return (
    <main className="page-shell run-page">
      <header className="page-header">
        <div>
          <p className="eyebrow"><a href="/">Grovie</a> / Session detail</p>
          <h1>{state.session.sessionId}</h1>
        </div>
      </header>

      <section className="summary-grid">
        <InfoPanel title="Identity">
          <DescriptionList
            items={[
              ["Issue", state.session.issueLabel],
              ["Agent", state.session.agentLabel],
              ["Runtime", state.session.latestRun.runtime ?? "(unknown)"],
              ["Runs", String(state.session.runs.length)],
              ["Latest", state.session.latestTime],
            ]}
          />
        </InfoPanel>
        <InfoPanel title="Execution">
          <DescriptionList
            mono
            items={[
              ["Branch", state.session.latestRun.branchName ?? "(unknown)"],
              ["Worktree", state.session.latestRun.worktreePath ?? "(unknown)"],
              ["Run directory", state.session.latestRun.runDir],
              ["Agent session", renderAgentSessionCommand(state.session.latestRun)],
            ]}
          />
        </InfoPanel>
      </section>

      <section className="run-stack">
        {state.session.runs.map((run, index) => (
          <SessionRunDetails key={run.runId} run={run} defaultOpen={index === 0 || isActiveRunStatus(run.status)} />
        ))}
      </section>
    </main>
  );
}

function SessionRunDetails(props: { run: LocalRunSummary; defaultOpen: boolean }): ReactNode {
  return (
    <details className="run-detail-card" open={props.defaultOpen}>
      <summary>
        <div className="run-detail-summary">
          <div>
            <strong>{props.run.runId}</strong>
            <p>{renderRunReason(props.run)} · started {props.run.startedAt ?? "(unknown)"}</p>
          </div>
          <div className="summary-actions">
            <span className={`status-badge compact status-${props.run.status}`}>{props.run.status}</span>
            <span className="summary-chevron" aria-hidden="true" />
          </div>
        </div>
      </summary>
      <SessionRunBody runId={props.run.runId} />
    </details>
  );
}

function SessionRunBody(props: { runId: string }): ReactNode {
  const [state, setState] = useState<RunDetailState>({ status: "loading" });
  const [tab, setTab] = useState<HandoffTab>("prompt");

  useEffect(() => {
    let canceled = false;

    loadRunDetail(props.runId)
      .then((nextState) => {
        if (!canceled) {
          setState(nextState);
          setTab("prompt");
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [props.runId]);

  if (state.status === "loading") {
    return <p className="muted-copy">Loading run detail.</p>;
  }

  if (state.status !== "ready") {
    return <p className="muted-copy">{state.message}</p>;
  }

  return <RunHandoffPanel state={state} tab={tab} onTabChange={setTab} />;
}

function RunDetailPage(props: { runId: string }): ReactNode {
  const [state, setState] = useState<RunDetailState>({ status: "loading" });
  const [cancelState, setCancelState] = useState<{ status: "idle" | "submitting" | "done" | "error"; message?: string }>({
    status: "idle",
  });

  useEffect(() => {
    let canceled = false;

    loadRunDetail(props.runId)
      .then((nextState) => {
        if (!canceled) {
          setState(nextState);
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [props.runId]);

  async function cancelRun(): Promise<void> {
    if (state.status !== "ready") {
      return;
    }

    if (!window.confirm("Cancel this local run?")) {
      return;
    }

    setCancelState({ status: "submitting" });
    const result = await cancelRunRequest(state.run.runId, fetch);

    if (!result.ok) {
      setCancelState({
        status: "error",
        message: result.message,
      });
      return;
    }

    setCancelState({
      status: "done",
      message: "Cancellation request recorded.",
    });
  }

  if (state.status === "loading") {
    return <CenteredNotice title="Loading run" message={`Fetching ${props.runId}.`} />;
  }

  if (state.status === "not-found") {
    return <CenteredNotice title="Run not found" message={state.message} />;
  }

  if (state.status === "error") {
    return <CenteredNotice title="Run detail unavailable" message={state.message} />;
  }

  return (
    <RunDetailContent
      state={state}
      cancelState={cancelState}
      onCancel={() => void cancelRun()}
    />
  );
}

export function RunDetailContent(props: {
  state: Extract<RunDetailState, { status: "ready" }>;
  cancelState: { status: "idle" | "submitting" | "done" | "error"; message?: string };
  onCancel: () => void;
}): ReactNode {
  const run = props.state.run;
  const canCancel = isCancelableRun(run.status);
  const [tab, setTab] = useState<HandoffTab>("prompt");

  return (
    <main className="page-shell run-page">
      <header className="page-header">
        <div>
          <p className="eyebrow"><a href="/">Grovie</a> / Run detail</p>
          <h1>{run.runId}</h1>
        </div>
        <span className={`status-badge status-${run.status}`}>{run.status}</span>
      </header>

      <section className="summary-grid">
        <InfoPanel title="Identity">
          <DescriptionList
            items={[
              ["Issue", renderIssueReference(run)],
              ["Agent", run.agentId ?? "(unknown)"],
              ["Runtime", run.runtime ?? "(unknown)"],
              ["Run reason", renderRunReason(run)],
              ["Source run", run.runRequest?.sourceRunId ?? "(none)"],
            ]}
          />
        </InfoPanel>
        <InfoPanel title="Execution">
          <DescriptionList
            items={[
              ["Branch", run.branchName ?? "(unknown)"],
              ["Local branch", run.localBranchName ?? "(unknown)"],
              ["Started", run.startedAt ?? "(unknown)"],
              ["Ended", run.endedAt ?? "(not ended)"],
              ["Last event", renderLastEvent(run)],
            ]}
          />
        </InfoPanel>
        <InfoPanel title="Actions">
          {canCancel ? (
            <div className="action-stack">
              <button className="danger-button" type="button" onClick={props.onCancel} disabled={props.cancelState.status === "submitting"}>
                {props.cancelState.status === "submitting" ? "Canceling..." : "Cancel run"}
              </button>
              <p>{props.cancelState.message ?? "Active local runs can be canceled from this machine."}</p>
            </div>
          ) : (
            <p className="muted-copy">This run is {run.status}; only active local runs can be canceled.</p>
          )}
        </InfoPanel>
      </section>

      <InfoPanel title="Paths">
        <DescriptionList
          mono
          items={[
            ["Worktree", run.worktreePath ?? "(unknown)"],
            ["Run directory", run.runDir],
            ["Repository cache", run.repositoryCachePath ?? "(unknown)"],
            ["Prompt", run.promptPath],
            ["Task", run.taskPath],
            ["Stdout", run.stdoutPath],
            ["Stderr", run.stderrPath],
          ]}
        />
      </InfoPanel>

      <RunHandoffPanel state={props.state} tab={tab} onTabChange={setTab} />

      <section className="logs-grid">
        <LogPanel runId={run.runId} log={props.state.stdout} transcript={props.state.stdoutTranscript.transcript} />
        <LogPanel runId={run.runId} log={props.state.stderr} />
      </section>

      <section className="split-layout">
        <InfoPanel title="Result Links">
          {run.resultLinks.length === 0 ? (
            <p className="muted-copy">(none)</p>
          ) : (
            <ul className="link-list">
              {run.resultLinks.map((link) => (
                <li key={link}>
                  <a href={link}>{link}</a>
                </li>
              ))}
            </ul>
          )}
        </InfoPanel>
        <InfoPanel title="Events">
          {props.state.events.length === 0 ? (
            <p className="muted-copy">No events recorded.</p>
          ) : (
            <ol className="event-list">
              {props.state.events.map((event, index) => (
                <li key={`${event.timestamp ?? "no-time"}-${event.type}-${index}`}>
                  <div>
                    <code>{event.type}</code>
                    <span>{event.timestamp ?? "(no timestamp)"}</span>
                  </div>
                  {event.data === undefined ? null : <pre>{JSON.stringify(event.data, null, 2)}</pre>}
                </li>
              ))}
            </ol>
          )}
        </InfoPanel>
      </section>
    </main>
  );
}

function RunHandoffPanel(props: {
  state: RunDetailReadyState;
  tab: HandoffTab;
  onTabChange: (tab: HandoffTab) => void;
}): ReactNode {
  const tabs: Array<[HandoffTab, string]> = [
    ["prompt", "Prompt"],
    ["task", "Task JSON"],
    ["stdout", "Stdout"],
    ["stderr", "Stderr"],
    ["events", "Events"],
  ];

  return (
    <div className="run-handoff">
      <div className="tab-list">
        {tabs.map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            className={props.tab === tab ? "active" : undefined}
            onClick={() => props.onTabChange(tab)}
          >
            {label}
          </button>
        ))}
      </div>
      {props.tab === "prompt" ? <FileBlock path={props.state.prompt.path} content={props.state.prompt.content} /> : null}
      {props.tab === "task" ? <FileBlock path={props.state.task.path} content={formatJsonText(props.state.task.content)} /> : null}
      {props.tab === "stdout" ? (
        <div className="embedded-log-panel">
          <LogPanel runId={props.state.run.runId} log={props.state.stdout} transcript={props.state.stdoutTranscript.transcript} />
        </div>
      ) : null}
      {props.tab === "stderr" ? (
        <div className="embedded-log-panel">
          <LogPanel runId={props.state.run.runId} log={props.state.stderr} />
        </div>
      ) : null}
      {props.tab === "events" ? (
        <pre className="file-output">
          <code>{JSON.stringify(props.state.events, null, 2)}</code>
        </pre>
      ) : null}
    </div>
  );
}

function FileBlock(props: { path: string; content: string; dark?: boolean }): ReactNode {
  return (
    <>
      <p className="log-path">{props.path}</p>
      <pre className={props.dark === true ? "file-output dark" : "file-output"}>
        <code>{props.content.length === 0 ? "(empty)" : props.content}</code>
      </pre>
    </>
  );
}

function formatJsonText(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content) as unknown, null, 2);
  } catch {
    return content;
  }
}

function InfoPanel(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="panel">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function DescriptionList(props: { items: Array<[string, string]>; mono?: boolean }): ReactNode {
  return (
    <dl className={props.mono === true ? "description-list mono-values" : "description-list"}>
      {props.items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LogPanel(props: { runId: string; log: AdminApiRunLogResponse; transcript?: RuntimeTranscript }): ReactNode {
  const [mode, setMode] = useState<"raw" | "transcript">(
    props.transcript?.recognized === true ? "transcript" : "raw",
  );
  const canShowTranscript = props.log.stream === "stdout" && props.transcript !== undefined;
  return (
    <section className="panel log-panel">
      <div className="section-heading">
        <h2>{props.log.stream}</h2>
        <a href={`/api/runs/${encodeURIComponent(props.runId)}/logs/${props.log.stream}`}>Raw</a>
      </div>
      <p className="log-path">{props.log.path}</p>
      {canShowTranscript ? (
        <div className="log-mode-selector" aria-label="stdout log display mode">
          <button type="button" className={mode === "raw" ? "active" : undefined} onClick={() => setMode("raw")}>
            Raw stdout
          </button>
          <button type="button" className={mode === "transcript" ? "active" : undefined} onClick={() => setMode("transcript")}>
            Readable transcript
          </button>
        </div>
      ) : null}
      {canShowTranscript && props.transcript?.recognized === false && mode === "raw" ? (
        <p className="transcript-inline-fallback">
          Readable transcript unavailable: {props.transcript.message ?? "stdout was not recognized by the runtime transcript parser."}
        </p>
      ) : null}
      {mode === "transcript" && props.transcript !== undefined ? (
        <TranscriptView transcript={props.transcript} />
      ) : (
        <pre className="log-output">
          <code>{props.log.content.length === 0 ? "(no output)" : renderAnsi(props.log.content)}</code>
        </pre>
      )}
    </section>
  );
}

function TranscriptView(props: { transcript: RuntimeTranscript }): ReactNode {
  if (!props.transcript.recognized) {
    return (
      <div className="transcript-fallback">
        <strong>Readable transcript unavailable</strong>
        <p>{props.transcript.message ?? "stdout was not recognized by the runtime transcript parser."}</p>
      </div>
    );
  }

  if (props.transcript.entries.length === 0) {
    return (
      <div className="transcript-fallback">
        <strong>No transcript entries</strong>
        <p>The runtime stdout was recognized, but no displayable entries were found.</p>
      </div>
    );
  }

  return (
    <ol className="transcript-list">
      {buildTranscriptBlocks(props.transcript.entries).map((block, index) => (
        <li key={`${block.kind}-${index}`} className={`transcript-entry transcript-${block.kind}`}>
          {renderTranscriptBlock(block)}
        </li>
      ))}
    </ol>
  );
}

function buildTranscriptBlocks(entries: RuntimeTranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let activityEntries: RuntimeTranscriptEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "assistant_message") {
      if (activityEntries.length > 0) {
        blocks.push({ kind: "activity", entries: activityEntries });
        activityEntries = [];
      }

      blocks.push({ kind: "assistant", entry });
      continue;
    }

    activityEntries.push(entry);
  }

  if (activityEntries.length > 0) {
    blocks.push({ kind: "activity", entries: activityEntries });
  }

  return blocks;
}

function renderTranscriptBlock(block: TranscriptBlock): ReactNode {
  if (block.kind === "assistant") {
    return renderTranscriptEntry(block.entry);
  }

  return (
    <details className="transcript-activity">
      <summary className="transcript-label">Activity {renderTranscriptMeta([`${block.entries.length} entries`])}</summary>
      <ol className="transcript-activity-list">
        {block.entries.map((entry, index) => (
          <li key={`${entry.kind}-${index}`} className={`transcript-activity-entry transcript-${entry.kind}`}>
            {renderTranscriptEntry(entry)}
          </li>
        ))}
      </ol>
    </details>
  );
}

function renderTranscriptEntry(entry: RuntimeTranscriptEntry): ReactNode {
  if (entry.kind === "assistant_message") {
    return (
      <>
        <div className="transcript-label">Assistant</div>
        <p>{entry.text}</p>
      </>
    );
  }

  if (entry.kind === "command_execution") {
    return (
      <details className="transcript-command">
        <summary className="transcript-label">Command {renderTranscriptMeta([entry.status, entry.exitCode === undefined ? undefined : `exit ${entry.exitCode}`])}</summary>
        <pre><code>{entry.command}</code></pre>
      </details>
    );
  }

  if (entry.kind === "command_output") {
    return (
      <details className="transcript-command">
        <summary className="transcript-label">Command output</summary>
        <pre><code>{entry.text}</code></pre>
      </details>
    );
  }

  if (entry.kind === "exit_code") {
    return <div className="transcript-label">Exit code {entry.exitCode}{entry.detail === undefined ? "" : ` (${entry.detail})`}</div>;
  }

  if (entry.kind === "tool_call") {
    return (
      <>
        <div className="transcript-label">Tool {renderTranscriptMeta([entry.status])}</div>
        <p>{entry.label}{entry.detail === undefined ? "" : `: ${entry.detail}`}</p>
      </>
    );
  }

  return (
    <>
      <div className="transcript-label">{entry.label}</div>
      {entry.detail === undefined ? null : <p>{entry.detail}</p>}
    </>
  );
}

function renderTranscriptMeta(parts: Array<string | undefined>): ReactNode {
  const value = parts.filter((part) => part !== undefined && part.length > 0).join(", ");
  return value.length === 0 ? null : <span>{value}</span>;
}

function CenteredNotice(props: { title: string; message: string }): ReactNode {
  return (
    <main className="page-shell centered-notice">
      <section className="panel">
        <h1>{props.title}</h1>
        <p>{props.message}</p>
      </section>
    </main>
  );
}

export async function loadAdminHome(fetcher: typeof fetch = fetch): Promise<AdminHomeData> {
  const [healthPayload, configPayload, reposPayload, activityPayload, runsPayload] = await Promise.all([
    fetchJson<AdminHomeData["health"]>("/api/health", fetcher),
    fetchJson<AdminApiConfigResponse>("/api/config", fetcher),
    fetchJson<AdminApiRepositoriesResponse>("/api/repos", fetcher),
    fetchJson<AdminApiActivityResponse>("/api/activity", fetcher),
    fetchJson<AdminApiRunsResponse>("/api/runs", fetcher),
  ]);

  return {
    health: healthPayload,
    config: {
      path: configPayload.path,
    },
    repositories: reposPayload.repositories,
    activity: activityPayload.activity,
    runs: runsPayload.runs,
  };
}

export async function loadRunDetail(runId: string, fetcher: typeof fetch = fetch): Promise<RunDetailState> {
  const encodedRunId = encodeURIComponent(runId);
  const runResponse = await fetcher(`/api/runs/${encodedRunId}`);

  if (runResponse.status === 404) {
    return {
      status: "not-found",
      message: "Run not found.",
    };
  }

  const runPayload = await readJson(runResponse) as Partial<AdminApiRunDetailResponse> & Partial<AdminApiErrorResponse>;

  if (!runResponse.ok || runPayload.run === undefined) {
    return {
      status: "error",
      message: apiMessage(runPayload, `Run detail failed with status ${runResponse.status}.`),
    };
  }

  const [eventsPayload, stdoutPayload, stderrPayload, stdoutTranscriptPayload, promptPayload, taskPayload] = await Promise.all([
    fetchJson<AdminApiRunEventsResponse>(`/api/runs/${encodedRunId}/events`, fetcher),
    fetchJson<AdminApiRunLogResponse>(`/api/runs/${encodedRunId}/logs/stdout`, fetcher),
    fetchJson<AdminApiRunLogResponse>(`/api/runs/${encodedRunId}/logs/stderr`, fetcher),
    fetchJson<AdminApiRunLogTranscriptResponse>(`/api/runs/${encodedRunId}/logs/stdout/transcript`, fetcher),
    fetchJson<AdminApiRunFileResponse>(`/api/runs/${encodedRunId}/prompt`, fetcher),
    fetchJson<AdminApiRunFileResponse>(`/api/runs/${encodedRunId}/task`, fetcher),
  ]);

  return {
    status: "ready",
    run: runPayload.run,
    events: eventsPayload.events,
    stdout: stdoutPayload,
    stderr: stderrPayload,
    stdoutTranscript: stdoutTranscriptPayload,
    prompt: promptPayload,
    task: taskPayload,
  };
}

export async function loadSessionDetail(sessionId: string, fetcher: typeof fetch = fetch): Promise<SessionDetailState> {
  const runsPayload = await fetchJson<AdminApiRunsResponse>("/api/runs", fetcher);
  const session = groupRunsByIssueAndAgent(runsPayload.runs).find((group) => group.sessionId === sessionId);

  if (session === undefined) {
    return {
      status: "not-found",
      message: "Session not found.",
    };
  }

  return {
    status: "ready",
    session,
  };
}

export async function cancelRunRequest(runId: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  const payload = await readJson(response) as Partial<AdminApiCancelRunResponse> & Partial<AdminApiErrorResponse>;

  if (!response.ok) {
    return {
      ok: false,
      message: apiMessage(payload, `Cancel failed with status ${response.status}.`),
    };
  }

  return {
    ok: true,
    message: "Cancellation request recorded.",
  };
}

async function fetchJson<T>(url: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(url);
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(apiMessage(payload, `Request failed with status ${response.status}.`));
  }

  return payload as T;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text.length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
}

function apiMessage(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
    ? value.message
    : fallback;
}

export function readRoute(pathname: string): { name: "home" } | { name: "run-detail"; runId: string } | { name: "session-detail"; sessionId: string } {
  const match = /^\/runs\/(?<runId>[^/]+)$/.exec(pathname);

  if (match?.groups?.runId !== undefined) {
    return {
      name: "run-detail",
      runId: decodeURIComponent(match.groups.runId),
    };
  }

  const sessionMatch = /^\/sessions\/(?<sessionId>[^/]+)$/.exec(pathname);

  if (sessionMatch?.groups?.sessionId !== undefined) {
    return {
      name: "session-detail",
      sessionId: decodeURIComponent(sessionMatch.groups.sessionId),
    };
  }

  return { name: "home" };
}

function renderIssueReference(run: LocalRunSummary): string {
  if (run.repository === undefined && run.issueNumber === undefined) {
    return "(unknown)";
  }

  return `${run.repository ?? "(unknown)"}${run.issueNumber === undefined ? "" : `#${run.issueNumber}`}`;
}

export function renderRunReason(run: LocalRunSummary): string {
  if (run.runRequest?.reason === undefined && run.runRequest?.sourceRunId === undefined) {
    return "(none)";
  }

  return [
    run.runRequest.reason ?? "(unknown reason)",
    run.runRequest.sourceRunId === undefined ? undefined : `source run ${run.runRequest.sourceRunId}`,
  ].filter((part) => part !== undefined).join("; ");
}

function renderLastEvent(run: LocalRunSummary): string {
  if (run.lastEventType === undefined && run.lastEventTime === undefined) {
    return "(none)";
  }

  return `${run.lastEventType ?? "(unknown)"} at ${run.lastEventTime ?? "(unknown)"}`;
}

function renderDaemonSummary(daemon: AdminApiHealthResponse["daemon"]): string {
  if (daemon.status === "running" && daemon.state?.pid !== undefined) {
    return `running pid ${daemon.state.pid}`;
  }

  return daemon.status;
}

export function isCancelableRun(status: LocalRunSummary["status"]): boolean {
  return status === "preparing" || status === "prepared" || status === "running" || status === "stale";
}

export function renderAnsi(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\x1B\[(?<code>\d+)m/g;
  let index = 0;
  let activeClass: string | undefined;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    appendAnsiText(nodes, value.slice(index, match.index), activeClass);
    activeClass = match.groups?.code === "0" ? undefined : ansiClass(match.groups?.code) ?? activeClass;
    index = pattern.lastIndex;
  }

  appendAnsiText(nodes, value.slice(index), activeClass);
  return nodes;
}

function appendAnsiText(nodes: ReactNode[], text: string, className: string | undefined): void {
  if (text.length === 0) {
    return;
  }

  const key = nodes.length;
  nodes.push(className === undefined ? text : <span key={key} className={className}>{text}</span>);
}

function ansiClass(code: string | undefined): string | undefined {
  if (code === "31") {
    return "ansi-red";
  }

  if (code === "32") {
    return "ansi-green";
  }

  if (code === "33") {
    return "ansi-yellow";
  }

  if (code === "34") {
    return "ansi-blue";
  }

  return undefined;
}

export function StrictApp(): ReactNode {
  return (
    <StrictMode>
      <App />
    </StrictMode>
  );
}
