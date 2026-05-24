import type { ReactNode } from "react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import "./styles.css";

type RunStatus =
  | "preparing"
  | "prepared"
  | "running"
  | "interrupting"
  | "interrupted"
  | "resuming"
  | "rejected"
  | "succeeded"
  | "failed"
  | "canceled"
  | "stale"
  | "unknown";

type RunEvent = {
  timestamp?: string;
  type: string;
  data?: Record<string, unknown>;
};

type LocalRunSummary = {
  runId: string;
  runDir: string;
  repository?: string;
  issueNumber?: number;
  agentId?: string;
  runtime?: string;
  status: RunStatus;
  branchName?: string;
  localBranchName?: string;
  repositoryCachePath?: string;
  worktreePath?: string;
  stdoutPath: string;
  stderrPath: string;
  promptPath: string;
  taskPath: string;
  startedAt?: string;
  endedAt?: string;
  lastEventTime?: string;
  lastEventType?: string;
  createdAt?: string;
  runRequest?: {
    sourceRunId?: string;
    reason?: string;
  };
  resultLinks: string[];
  events: RunEvent[];
};

type RunDetailState =
  | { status: "loading" }
  | { status: "not-found"; message: string }
  | { status: "error"; message: string }
  | {
    status: "ready";
    run: LocalRunSummary;
    events: RunEvent[];
    stdout: RunLog;
    stderr: RunLog;
  };

type RunLog = {
  stream: "stdout" | "stderr";
  path: string;
  content: string;
};

export function App(): ReactNode {
  const route = useMemo(() => readRoute(window.location.pathname), []);

  if (route.name === "run-detail") {
    return <RunDetailPage runId={route.runId} />;
  }

  return <AdminHome />;
}

function AdminHome(): ReactNode {
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Local admin console</p>
          <h1>Grovie</h1>
        </div>
        <div className="status-pill">Served by the local daemon</div>
      </header>

      <section className="tile-grid" aria-label="Admin console status">
        <StatusTile icon="D" label="Daemon" value="Local process" />
        <StatusTile icon="R" label="Runs" value="API backed" />
        <StatusTile icon="G" label="Control plane" value="GitHub native" />
      </section>

      <section className="split-layout">
        <div className="panel">
          <h2>Admin web shell</h2>
          <p>
            This React shell is served from the Grovie daemon process. Existing admin APIs remain available under{" "}
            <code>/api</code>, while the browser app owns local routes such as <code>/runs/:runId</code>.
          </p>
        </div>
        <div className="panel">
          <h2>Runtime boundary</h2>
          <p>Built assets come from the root build output, so production serving does not depend on Vite.</p>
        </div>
      </section>
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

function StatusTile(props: { icon: string; label: string; value: string }): ReactNode {
  return (
    <div className="tile">
      <span className="tile-icon">{props.icon}</span>
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

function LogPanel(props: { runId: string; log: RunLog }): ReactNode {
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

export async function loadRunDetail(runId: string, fetcher: typeof fetch = fetch): Promise<RunDetailState> {
  const encodedRunId = encodeURIComponent(runId);
  const runResponse = await fetcher(`/api/runs/${encodedRunId}`);

  if (runResponse.status === 404) {
    return {
      status: "not-found",
      message: "Run not found.",
    };
  }

  const runPayload = await readJson(runResponse) as { run?: LocalRunSummary };

  if (!runResponse.ok || runPayload.run === undefined) {
    return {
      status: "error",
      message: apiMessage(runPayload, `Run detail failed with status ${runResponse.status}.`),
    };
  }

  const [eventsPayload, stdoutPayload, stderrPayload] = await Promise.all([
    fetchJson<{ events: RunEvent[] }>(`/api/runs/${encodedRunId}/events`, fetcher),
    fetchJson<RunLog>(`/api/runs/${encodedRunId}/logs/stdout`, fetcher),
    fetchJson<RunLog>(`/api/runs/${encodedRunId}/logs/stderr`, fetcher),
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
  const payload = await readJson(response);

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

export function isCancelableRun(status: RunStatus): boolean {
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
