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
  AdminApiRunsResponse,
  AdminApiRunLogResponse,
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
  };

export function App(): ReactNode {
  const route = useMemo(() => readRoute(window.location.pathname), []);

  if (route.name === "run-detail") {
    return <RunDetailPage runId={route.runId} />;
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
  const runtime = props.data.health.runtime;
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

      <section className="tile-grid" aria-label="Admin console status">
        <StatusTile icon="D" label="Daemon" value={renderDaemonSummary(daemon)} tone={daemon.status === "running" ? "success" : "neutral"} />
        <StatusTile icon="R" label="Runtime" value={`${runtime.runtime}: ${runtime.available ? "available" : "unavailable"}`} tone={runtime.available ? "success" : "danger"} />
        <StatusTile icon="W" label="Watched repos" value={String(props.data.repositories.length)} />
      </section>

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
        <InfoPanel title="Runtime">
          <DescriptionList
            items={[
              ["Runtime", runtime.runtime],
              ["Available", runtime.available ? "yes" : "no"],
              ["Message", runtime.message],
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

      <section className="split-layout">
        <InfoPanel title="Watched Repositories">
          {props.data.repositories.length === 0 ? (
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
                {props.data.repositories.map((repository) => (
                  <tr key={`${repository.repository}-${repository.label ?? ""}`}>
                    <td>{repository.repository}</td>
                    <td>{repository.label ?? "(default)"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </InfoPanel>
        <InfoPanel title="Recent Activity">
          {activity.length === 0 ? (
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
                {activity.map((entry, index) => (
                  <tr key={`${entry.timestamp}-${entry.type}-${index}`}>
                    <td>{entry.timestamp}</td>
                    <td><code>{entry.type}</code></td>
                    <td>{entry.repository ?? "(none)"}</td>
                    <td>{entry.issueNumber === undefined ? "(none)" : `#${entry.issueNumber}`}</td>
                    <td>{entry.agentId ?? "(none)"}</td>
                    <td>{entry.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </InfoPanel>
      </section>

      <InfoPanel title="Recent Runs">
        {runs.length === 0 ? (
          <p className="muted-copy">No local runs found.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Issue</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Runtime</th>
                <th>Branch</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td><a href={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</a></td>
                  <td>{renderIssueReference(run)}</td>
                  <td><span className={`status-badge compact status-${run.status}`}>{run.status}</span></td>
                  <td>{run.agentId ?? "(unknown)"}</td>
                  <td>{run.runtime ?? "(unknown)"}</td>
                  <td>{run.branchName ?? "(unknown)"}</td>
                  <td>{run.startedAt ?? "(unknown)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </InfoPanel>
    </main>
  );
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

  return (
    <main className="page-shell run-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Run detail</p>
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

      <section className="logs-grid">
        <LogPanel runId={run.runId} log={props.state.stdout} />
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

function StatusTile(props: { icon: string; label: string; value: string; tone?: "neutral" | "success" | "danger" }): ReactNode {
  return (
    <div className="tile">
      <span className={`tile-icon tone-${props.tone ?? "neutral"}`}>{props.icon}</span>
      <div>
        <p>{props.label}</p>
        <strong>{props.value}</strong>
      </div>
    </div>
  );
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

function LogPanel(props: { runId: string; log: AdminApiRunLogResponse }): ReactNode {
  return (
    <section className="panel log-panel">
      <div className="section-heading">
        <h2>{props.log.stream}</h2>
        <a href={`/api/runs/${encodeURIComponent(props.runId)}/logs/${props.log.stream}`}>Raw</a>
      </div>
      <p className="log-path">{props.log.path}</p>
      <pre className="log-output">
        <code>{props.log.content.length === 0 ? "(no output)" : renderAnsi(props.log.content)}</code>
      </pre>
    </section>
  );
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

  const [eventsPayload, stdoutPayload, stderrPayload] = await Promise.all([
    fetchJson<AdminApiRunEventsResponse>(`/api/runs/${encodedRunId}/events`, fetcher),
    fetchJson<AdminApiRunLogResponse>(`/api/runs/${encodedRunId}/logs/stdout`, fetcher),
    fetchJson<AdminApiRunLogResponse>(`/api/runs/${encodedRunId}/logs/stderr`, fetcher),
  ]);

  return {
    status: "ready",
    run: runPayload.run,
    events: eventsPayload.events,
    stdout: stdoutPayload,
    stderr: stderrPayload,
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

export function readRoute(pathname: string): { name: "home" } | { name: "run-detail"; runId: string; } {
  const match = /^\/runs\/(?<runId>[^/]+)$/.exec(pathname);

  if (match?.groups?.runId !== undefined) {
    return {
      name: "run-detail",
      runId: decodeURIComponent(match.groups.runId),
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
