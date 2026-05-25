import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfiguredAgentHealth, getRuntimeHealth } from "../../agent-health.js";
import { loadGlobalConfig } from "../../config.js";
import { readDaemonActivity } from "../../daemon-activity.js";
import { resolveLocalIdentity } from "../../identity.js";
import { parseRuntimeStdoutTranscript } from "../../runtime-transcript.js";
import { findLocalRun, listLocalRuns } from "../../status.js";
import type {
  AdminApiActivityResponse,
  AdminApiConfigResponse,
  AdminApiErrorResponse,
  AdminApiHealthResponse,
  AdminApiRepositoriesResponse,
  AdminApiRunDetailResponse,
  AdminApiRunEventsResponse,
  AdminApiRunFileResponse,
  AdminApiRunLogResponse,
  AdminApiRunLogTranscriptResponse,
  AdminApiRunsResponse,
} from "../../admin-api.js";
import type { AdminConsoleContext } from "./types.js";
import { renderApiDaemonStatus } from "./daemon-status.js";
import { writeJson } from "./http.js";
import { isLogStream, readLocalTextFile, readRunLog } from "./run-data.js";
import { startRunLogStream } from "./stream.js";

export function handleAdminApiGet(context: AdminConsoleContext, request: IncomingMessage, url: URL, response: ServerResponse): void {
  if (url.pathname === "/api/health") {
    const globalConfig = loadGlobalConfig(context.paths.root);
    const identity = resolveLocalIdentity();
    const body: AdminApiHealthResponse = {
      ok: true,
      daemon: renderApiDaemonStatus(context.daemonLifecycle.status({ root: context.paths.root })),
      runtimes: getRuntimeHealth(context.runtimeAvailabilityChecker),
      agents: getConfiguredAgentHealth(globalConfig.config, identity.machineId, context.runtimeAvailabilityChecker),
    };
    writeJson(response, 200, body);
    return;
  }

  if (url.pathname === "/api/config") {
    const globalConfig = loadGlobalConfig(context.paths.root);

    const body: AdminApiConfigResponse = {
      path: globalConfig.path,
      config: globalConfig.config,
    };
    writeJson(response, 200, body);
    return;
  }

  if (url.pathname === "/api/repos") {
    const body: AdminApiRepositoriesResponse = {
      repositories: loadGlobalConfig(context.paths.root).config.watchedRepositories,
    };
    writeJson(response, 200, body);
    return;
  }

  if (url.pathname === "/api/runs") {
    const body: AdminApiRunsResponse = {
      runs: listLocalRuns(context.paths.runsDir),
    };
    writeJson(response, 200, body);
    return;
  }

  if (url.pathname === "/api/activity") {
    const body: AdminApiActivityResponse = {
      activity: readDaemonActivity(context.paths, 50),
    };
    writeJson(response, 200, body);
    return;
  }

  const runEventsMatch = /^\/api\/runs\/(?<runId>[^/]+)\/events$/.exec(url.pathname);

  if (runEventsMatch?.groups?.runId !== undefined) {
    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runEventsMatch.groups.runId));

    if (run === undefined) {
      const body: AdminApiErrorResponse = {
        error: "not_found",
        message: "Run not found.",
      };
      writeJson(response, 404, body);
      return;
    }

    const body: AdminApiRunEventsResponse = {
      runId: run.runId,
      events: run.events,
    };
    writeJson(response, 200, body);
    return;
  }

  const runLogMatch = /^\/api\/runs\/(?<runId>[^/]+)\/logs\/(?<stream>stdout|stderr)$/.exec(url.pathname);

  if (runLogMatch?.groups?.runId !== undefined && isLogStream(runLogMatch.groups.stream)) {
    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runLogMatch.groups.runId));

    if (run === undefined) {
      const body: AdminApiErrorResponse = {
        error: "not_found",
        message: "Run not found.",
      };
      writeJson(response, 404, body);
      return;
    }

    const log = readRunLog(run, runLogMatch.groups.stream);

    const body: AdminApiRunLogResponse = {
      runId: run.runId,
      stream: runLogMatch.groups.stream,
      path: log.path,
      content: log.content,
    };
    writeJson(response, 200, body);
    return;
  }

  const runPromptMatch = /^\/api\/runs\/(?<runId>[^/]+)\/prompt$/.exec(url.pathname);

  if (runPromptMatch?.groups?.runId !== undefined) {
    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runPromptMatch.groups.runId));

    if (run === undefined) {
      const body: AdminApiErrorResponse = {
        error: "not_found",
        message: "Run not found.",
      };
      writeJson(response, 404, body);
      return;
    }

    const body: AdminApiRunFileResponse = {
      runId: run.runId,
      path: run.promptPath,
      content: readLocalTextFile(run.promptPath),
    };
    writeJson(response, 200, body);
    return;
  }

  const runTaskMatch = /^\/api\/runs\/(?<runId>[^/]+)\/task$/.exec(url.pathname);

  if (runTaskMatch?.groups?.runId !== undefined) {
    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runTaskMatch.groups.runId));

    if (run === undefined) {
      const body: AdminApiErrorResponse = {
        error: "not_found",
        message: "Run not found.",
      };
      writeJson(response, 404, body);
      return;
    }

    const body: AdminApiRunFileResponse = {
      runId: run.runId,
      path: run.taskPath,
      content: readLocalTextFile(run.taskPath),
    };
    writeJson(response, 200, body);
    return;
  }

  const runTranscriptMatch = /^\/api\/runs\/(?<runId>[^/]+)\/logs\/stdout\/transcript$/.exec(url.pathname);

  if (runTranscriptMatch?.groups?.runId !== undefined) {
    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runTranscriptMatch.groups.runId));

    if (run === undefined) {
      writeJson(response, 404, {
        error: "not_found",
        message: "Run not found.",
      });
      return;
    }

    const log = readRunLog(run, "stdout");

    const body: AdminApiRunLogTranscriptResponse = {
      runId: run.runId,
      stream: "stdout",
      path: log.path,
      transcript: parseRuntimeStdoutTranscript(run.runtime, log.content),
    };
    writeJson(response, 200, body);
    return;
  }

  const runLogStreamMatch = /^\/api\/runs\/(?<runId>[^/]+)\/logs\/stream$/.exec(url.pathname);

  if (runLogStreamMatch?.groups?.runId !== undefined) {
    const stream = url.searchParams.get("stream");

    if (stream !== "stdout" && stream !== "stderr") {
      const body: AdminApiErrorResponse = {
        error: "invalid_stream",
        message: "Expected stream=stdout or stream=stderr.",
      };
      writeJson(response, 400, body);
      return;
    }

    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runLogStreamMatch.groups.runId));

    if (run === undefined) {
      const body: AdminApiErrorResponse = {
        error: "not_found",
        message: "Run not found.",
      };
      writeJson(response, 404, body);
      return;
    }

    startRunLogStream(request, response, run, stream);
    return;
  }

  const runMatch = /^\/api\/runs\/(?<runId>[^/]+)$/.exec(url.pathname);

  if (runMatch?.groups?.runId !== undefined) {
    const run = findLocalRun(context.paths.runsDir, decodeURIComponent(runMatch.groups.runId));

    if (run === undefined) {
      const body: AdminApiErrorResponse = {
        error: "not_found",
        message: "Run not found.",
      };
      writeJson(response, 404, body);
      return;
    }

    const body: AdminApiRunDetailResponse = {
      run,
    };
    writeJson(response, 200, body);
    return;
  }

  const body: AdminApiErrorResponse = {
    error: "not_found",
    message: "Admin console endpoint not found.",
  };
  writeJson(response, 404, body);
}
