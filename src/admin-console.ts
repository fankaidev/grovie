import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadGlobalConfig, type GlobalGrovieConfig } from "./config.js";
import type { DaemonLifecycle, DaemonLifecycleStatus } from "./daemon-lifecycle.js";
import { resolveLocalIdentity } from "./identity.js";
import { writeRunCancellation, type LocalStatePaths } from "./local-state.js";
import type { AgentRuntime } from "./runtime.js";
import { findLocalRun, listLocalRuns, type LocalRunSummary } from "./status.js";

export type AdminConsoleResolvedConfig = {
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
};

export type StartedAdminConsole = {
  server: Server;
  url: string;
};

export type AdminConsoleContext = {
  paths: LocalStatePaths;
  daemonLifecycle: DaemonLifecycle;
  runtime: AgentRuntime;
};

const DEFAULT_ADMIN_CONSOLE_PORT = 8765;

export function resolveAdminConsoleConfig(config: GlobalGrovieConfig): AdminConsoleResolvedConfig {
  return {
    enabled: config.adminConsole?.enabled ?? false,
    host: config.adminConsole?.host ?? "127.0.0.1",
    port: config.adminConsole?.port ?? DEFAULT_ADMIN_CONSOLE_PORT,
  };
}

export function createAdminConsoleServer(context?: AdminConsoleContext): Server {
  return createServer((request, response) => {
    const url = parseRequestUrl(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "grovie-admin-console",
      });
      return;
    }

    if (context !== undefined && request.method === "POST") {
      const cancelMatch = /^\/api\/runs\/(?<runId>[^/]+)\/cancel$/.exec(url.pathname);

      if (cancelMatch?.groups?.runId !== undefined) {
        const runId = decodeURIComponent(cancelMatch.groups.runId);
        const run = findLocalRun(context.paths.runsDir, runId);

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        if (!isCancelableRun(run)) {
          writeJson(response, 409, {
            error: "not_cancelable",
            message: `Run ${run.runId} is ${run.status}; only active local runs can be canceled.`,
          });
          return;
        }

        const cancellation = writeRunCancellation(context.paths, {
          runId,
          reason: "Canceled from local admin console.",
        });

        writeJson(response, 202, {
          ok: true,
          cancellation,
        });
        return;
      }
    }

    if (context !== undefined && request.method === "GET") {
      if (url.pathname === "/") {
        writeHtml(response, 200, renderAdminHome(context));
        return;
      }

      const runPageMatch = /^\/runs\/(?<runId>[^/]+)$/.exec(url.pathname);

      if (runPageMatch?.groups?.runId !== undefined) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runPageMatch.groups.runId));

        if (run === undefined) {
          writeHtml(response, 404, renderNotFoundPage("Run not found."));
          return;
        }

        writeHtml(response, 200, renderRunDetailPage(run));
        return;
      }

      if (url.pathname === "/api/health") {
        writeJson(response, 200, {
          ok: true,
          daemon: renderApiDaemonStatus(context.daemonLifecycle.status({ root: context.paths.root })),
          runtime: context.runtime.checkAvailability(),
        });
        return;
      }

      if (url.pathname === "/api/config") {
        const globalConfig = loadGlobalConfig(context.paths.root);

        writeJson(response, 200, {
          path: globalConfig.path,
          config: globalConfig.config,
        });
        return;
      }

      if (url.pathname === "/api/repos") {
        writeJson(response, 200, {
          repositories: loadGlobalConfig(context.paths.root).config.watchedRepositories,
        });
        return;
      }

      if (url.pathname === "/api/runs") {
        writeJson(response, 200, {
          runs: listLocalRuns(context.paths.runsDir),
        });
        return;
      }

      const runEventsMatch = /^\/api\/runs\/(?<runId>[^/]+)\/events$/.exec(url.pathname);

      if (runEventsMatch?.groups?.runId !== undefined) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runEventsMatch.groups.runId));

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        writeJson(response, 200, {
          runId: run.runId,
          events: run.events,
        });
        return;
      }

      const runLogMatch = /^\/api\/runs\/(?<runId>[^/]+)\/logs\/(?<stream>stdout|stderr)$/.exec(url.pathname);

      if (runLogMatch?.groups?.runId !== undefined && isLogStream(runLogMatch.groups.stream)) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runLogMatch.groups.runId));

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        const log = readRunLog(run, runLogMatch.groups.stream);

        writeJson(response, 200, {
          runId: run.runId,
          stream: runLogMatch.groups.stream,
          path: log.path,
          content: log.content,
        });
        return;
      }

      const runLogStreamMatch = /^\/api\/runs\/(?<runId>[^/]+)\/logs\/stream$/.exec(url.pathname);

      if (runLogStreamMatch?.groups?.runId !== undefined) {
        const stream = url.searchParams.get("stream");

        if (stream !== "stdout" && stream !== "stderr") {
          writeJson(response, 400, {
            error: "invalid_stream",
            message: "Expected stream=stdout or stream=stderr.",
          });
          return;
        }

        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runLogStreamMatch.groups.runId));

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        startRunLogStream(request, response, run, stream);
        return;
      }

      const runMatch = /^\/api\/runs\/(?<runId>[^/]+)$/.exec(url.pathname);

      if (runMatch?.groups?.runId !== undefined) {
        const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runMatch.groups.runId));

        if (run === undefined) {
          writeJson(response, 404, {
            error: "not_found",
            message: "Run not found.",
          });
          return;
        }

        writeJson(response, 200, {
          run,
        });
        return;
      }
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

function writeHtml(response: ServerResponse, statusCode: number, value: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(value);
}

function parseRequestUrl(url: string | undefined): URL {
  return new URL(url ?? "/", "http://127.0.0.1");
}

function renderApiDaemonStatus(status: DaemonLifecycleStatus): unknown {
  if (status.status === "stopped") {
    return status;
  }

  return {
    status: status.status,
    state: {
      pid: status.state.pid,
      command: status.state.command,
      startedAt: status.state.startedAt,
      stdoutPath: status.state.stdoutPath,
      stderrPath: status.state.stderrPath,
      statePath: status.state.statePath,
    },
  };
}

function renderAdminHome(context: AdminConsoleContext): string {
  const health = {
    daemon: renderApiDaemonStatus(context.daemonLifecycle.status({ root: context.paths.root })),
    runtime: context.runtime.checkAvailability(),
  };
  const globalConfig = loadGlobalConfig(context.paths.root);
  const runs = listLocalRuns(context.paths.runsDir).slice(0, 20);
  const identity = resolveLocalIdentity();

  return renderDocument("Grovie Admin Console", [
    "<h1>Grovie Admin Console</h1>",
    "<section>",
    "<h2>Machine</h2>",
    `<p>Machine id: ${escapeHtml(identity.machineId)}</p>`,
    `<p>State root: ${escapeHtml(context.paths.root)}</p>`,
    "</section>",
    "<section>",
    "<h2>Daemon</h2>",
    `<p>Status: ${escapeHtml(readStatus(health.daemon))}</p>`,
    `<p>State path: ${escapeHtml(readStatePath(health.daemon))}</p>`,
    "</section>",
    "<section>",
    "<h2>Runtime</h2>",
    `<p>${escapeHtml(health.runtime.runtime)}: ${escapeHtml(health.runtime.message)}</p>`,
    "</section>",
    "<section>",
    "<h2>Watched Repositories</h2>",
    renderWatchedRepositories(globalConfig.config.watchedRepositories),
    "</section>",
    "<section>",
    "<h2>Recent Runs</h2>",
    renderRunsTable(runs),
    "</section>",
  ].join("\n"));
}

function renderRunDetailPage(run: LocalRunSummary): string {
  return renderDocument(`Grovie Run ${run.runId}`, [
    `<h1>${escapeHtml(run.runId)}</h1>`,
    "<section>",
    "<h2>Summary</h2>",
    `<p>Status: ${escapeHtml(run.status)}</p>`,
    `<p>Issue: ${escapeHtml(renderIssueReference(run))}</p>`,
    `<p>Agent: ${escapeHtml(run.agentId ?? "(unknown)")}</p>`,
    `<p>Runtime: ${escapeHtml(run.runtime ?? "(unknown)")}</p>`,
    `<p>Run reason: ${escapeHtml(renderRunReason(run))}</p>`,
    `<p>Branch: ${escapeHtml(run.branchName ?? "(unknown)")}</p>`,
    `<p>Started: ${escapeHtml(run.startedAt ?? "(unknown)")}</p>`,
    `<p>Ended: ${escapeHtml(run.endedAt ?? "(not ended)")}</p>`,
    `<p>Result summary: ${escapeHtml(renderResultSummary(run))}</p>`,
    "</section>",
    "<section>",
    "<h2>Paths</h2>",
    `<p>Worktree: ${escapeHtml(run.worktreePath ?? "(unknown)")}</p>`,
    `<p>Run directory: ${escapeHtml(run.runDir)}</p>`,
    `<p>Prompt: ${escapeHtml(run.promptPath)}</p>`,
    `<p>Task: ${escapeHtml(run.taskPath)}</p>`,
    `<p>Stdout: ${escapeHtml(run.stdoutPath)}</p>`,
    `<p>Stderr: ${escapeHtml(run.stderrPath)}</p>`,
    "</section>",
    "<section>",
    "<h2>Logs</h2>",
    renderLogPreview(run, "stdout"),
    renderLogPreview(run, "stderr"),
    "</section>",
    ...(isCancelableRun(run)
      ? [
        "<section>",
        "<h2>Actions</h2>",
        `<form method="post" action="/api/runs/${encodeURIComponent(run.runId)}/cancel" onsubmit="return confirm('Cancel this local run?');">`,
        '<button type="submit">Cancel run</button>',
        "</form>",
        "</section>",
      ]
      : []),
    "<section>",
    "<h2>Result Links</h2>",
    renderLinks(run.resultLinks),
    "</section>",
    "<section>",
    "<h2>Recent Events</h2>",
    renderEvents(run),
    "</section>",
  ].join("\n"));
}

function renderDocument(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:24px;color:#172026;background:#f8fafb;line-height:1.4}",
    "main{max-width:1120px;margin:0 auto}",
    "section{border-top:1px solid #d8dee4;padding:16px 0}",
    "table{width:100%;border-collapse:collapse;background:#fff}",
    "th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}",
    "code{background:#eef2f5;padding:2px 4px;border-radius:4px}",
    ".ansi-red{color:#b91c1c}.ansi-green{color:#15803d}.ansi-yellow{color:#a16207}.ansi-blue{color:#1d4ed8}",
    "a{color:#075985}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderWatchedRepositories(repositories: Array<{ repository: string; label?: string }>): string {
  if (repositories.length === 0) {
    return "<p>No watched repositories configured.</p>";
  }

  return [
    "<ul>",
    ...repositories.map((repository) => `<li>${escapeHtml(repository.repository)}${repository.label === undefined ? "" : ` label=${escapeHtml(repository.label)}`}</li>`),
    "</ul>",
  ].join("\n");
}

function renderRunsTable(runs: LocalRunSummary[]): string {
  if (runs.length === 0) {
    return "<p>No local runs found.</p>";
  }

  return [
    "<table>",
    "<thead><tr><th>Run</th><th>Issue</th><th>Status</th><th>Agent</th><th>Branch</th><th>Started</th><th>Ended</th><th>Links</th></tr></thead>",
    "<tbody>",
    ...runs.map((run) => [
      "<tr>",
      `<td><a href="/runs/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></td>`,
      `<td>${escapeHtml(renderIssueReference(run))}</td>`,
      `<td>${escapeHtml(run.status)}</td>`,
      `<td>${escapeHtml(run.agentId ?? "(unknown)")}</td>`,
      `<td>${escapeHtml(run.branchName ?? "(unknown)")}</td>`,
      `<td>${escapeHtml(run.startedAt ?? "(unknown)")}</td>`,
      `<td>${escapeHtml(run.endedAt ?? "(not ended)")}</td>`,
      `<td>${renderLinks(run.resultLinks)}</td>`,
      "</tr>",
    ].join("")),
    "</tbody>",
    "</table>",
  ].join("\n");
}

function renderLinks(links: string[]): string {
  if (links.length === 0) {
    return "(none)";
  }

  return links.map((link) => `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`).join("<br>");
}

function renderEvents(run: LocalRunSummary): string {
  if (run.events.length === 0) {
    return "<p>No events recorded.</p>";
  }

  return [
    "<ul>",
    ...run.events.slice(-10).map((event) => `<li>${escapeHtml(event.timestamp ?? "(no timestamp)")} <code>${escapeHtml(event.type)}</code></li>`),
    "</ul>",
  ].join("\n");
}

function renderLogPreview(run: LocalRunSummary, stream: "stdout" | "stderr"): string {
  const log = readRunLog(run, stream);
  const content = log.content.length === 0 ? "(no output)" : renderAnsiHtml(log.content);

  return [
    `<h3>${stream}</h3>`,
    `<p><a href="/api/runs/${encodeURIComponent(run.runId)}/logs/${stream}">Raw ${stream}</a></p>`,
    `<pre><code>${content}</code></pre>`,
  ].join("\n");
}

function readRunLog(run: LocalRunSummary, stream: "stdout" | "stderr"): { path: string; content: string } {
  const path = stream === "stdout" ? run.stdoutPath : run.stderrPath;

  if (!existsSync(path)) {
    return {
      path,
      content: "",
    };
  }

  return {
    path,
    content: readFileSync(path, "utf8"),
  };
}

function isLogStream(value: string | undefined): value is "stdout" | "stderr" {
  return value === "stdout" || value === "stderr";
}

function startRunLogStream(
  request: IncomingMessage,
  response: ServerResponse,
  run: LocalRunSummary,
  stream: "stdout" | "stderr",
): void {
  const initialLog = readRunLog(run, stream);
  let offset = Buffer.byteLength(initialLog.content, "utf8");

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeServerSentEvent(response, "snapshot", {
    runId: run.runId,
    stream,
    path: initialLog.path,
    content: initialLog.content,
  });

  const interval = setInterval(() => {
    const nextLog = readRunLog(run, stream);
    const nextBuffer = Buffer.from(nextLog.content, "utf8");

    if (nextBuffer.length <= offset) {
      return;
    }

    const content = nextBuffer.subarray(offset).toString("utf8");
    offset = nextBuffer.length;
    writeServerSentEvent(response, "append", {
      runId: run.runId,
      stream,
      path: nextLog.path,
      content,
    });
  }, 100);

  request.on("close", () => {
    clearInterval(interval);
  });
}

function writeServerSentEvent(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function renderAnsiHtml(value: string): string {
  let output = "";
  let index = 0;
  const pattern = /\x1B\[(?<code>\d+)m/g;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    output += escapeHtml(value.slice(index, match.index));

    if (match.groups?.code === "0") {
      output += "</span>";
    } else {
      const className = ansiClass(match.groups?.code);

      if (className !== undefined) {
        output += `<span class="${className}">`;
      }
    }

    index = pattern.lastIndex;
  }

  output += escapeHtml(value.slice(index));
  return output;
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

function renderNotFoundPage(message: string): string {
  return renderDocument("Not Found", `<h1>Not Found</h1><p>${escapeHtml(message)}</p>`);
}

function renderIssueReference(run: LocalRunSummary): string {
  if (run.repository === undefined && run.issueNumber === undefined) {
    return "(unknown)";
  }

  return `${run.repository ?? "(unknown)"}${run.issueNumber === undefined ? "" : `#${run.issueNumber}`}`;
}

function renderResultSummary(run: LocalRunSummary): string {
  if (run.resultLinks.length > 0) {
    return `${run.status}; ${run.resultLinks.join(", ")}`;
  }

  return `${run.status}; last event ${run.lastEventType ?? "(none)"}`;
}

function isCancelableRun(run: LocalRunSummary): boolean {
  return run.status === "preparing" || run.status === "prepared" || run.status === "running" || run.status === "stale";
}

function readStatus(value: unknown): string {
  return typeof value === "object" && value !== null && "status" in value && typeof value.status === "string"
    ? value.status
    : "(unknown)";
}

function readStatePath(value: unknown): string {
  if (typeof value !== "object" || value === null || !("state" in value)) {
    return "(none)";
  }

  const state = value.state;

  return typeof state === "object" && state !== null && "statePath" in state && typeof state.statePath === "string"
    ? state.statePath
    : "(none)";
}

function renderRunReason(run: LocalRunSummary): string {
  if (run.runRequest === undefined) {
    return "(scheduled)";
  }

  const reason = run.runRequest.reason ?? "manual";
  return run.runRequest.sourceRunId === undefined ? reason : `${reason}; source run ${run.runRequest.sourceRunId}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
