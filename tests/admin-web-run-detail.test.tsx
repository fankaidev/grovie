import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdminHomeContent,
  RunDetailContent,
  cancelRunRequest,
  isCancelableRun,
  loadAdminHome,
  loadRunDetail,
  readRoute,
} from "../admin-web/src/app.js";

describe("admin web home route", () => {
  it("[UC-ADMIN-02-S01] [UC-ADMIN-02-S03] [UC-ADMIN-02-S04] [UC-ADMIN-02-S07] [UC-ADMIN-03-S01] fetches home screen data from existing admin APIs", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
      });

      if (url === "/api/health") {
        return jsonResponse(200, {
          ok: true,
          daemon: {
            status: "running",
            state: {
              pid: 321,
              startedAt: "2026-05-24T13:00:00.000Z",
              stdoutPath: "/state/daemon/stdout.log",
              stderrPath: "/state/daemon/stderr.log",
              statePath: "/state/daemon/daemon.json",
            },
          },
          runtime: {
            runtime: "codex",
            available: true,
            message: "codex is available.",
          },
        });
      }

      if (url === "/api/config") {
        return jsonResponse(200, {
          path: "/state/config.yml",
          config: {},
        });
      }

      if (url === "/api/repos") {
        return jsonResponse(200, {
          repositories: [{ repository: "fankaidev/grovie", label: "grovie" }],
        });
      }

      if (url === "/api/activity") {
        return jsonResponse(200, {
          activity: [{
            timestamp: "2026-05-24T13:01:00.000Z",
            type: "run.started",
            message: "Starting fankaidev/grovie#126 for coco@kai-mini.",
            repository: "fankaidev/grovie",
            issueNumber: 126,
            agentId: "coco@kai-mini",
          }],
        });
      }

      if (url === "/api/runs") {
        return jsonResponse(200, {
          runs: [{
            ...baseRun("run-126"),
            repository: "fankaidev/grovie",
            issueNumber: 126,
            agentId: "coco@kai-mini",
            runtime: "codex",
            branchName: "grovie/issue-126",
            startedAt: "2026-05-24T13:02:00.000Z",
          }],
        });
      }

      return jsonResponse(404, {
        error: "not_found",
      });
    };

    const data = await loadAdminHome(fetcher as typeof fetch);

    expect(data).toMatchObject({
      health: {
        daemon: {
          status: "running",
        },
        runtime: {
          runtime: "codex",
          available: true,
        },
      },
      config: {
        path: "/state/config.yml",
      },
      repositories: [{ repository: "fankaidev/grovie", label: "grovie" }],
      activity: [{ type: "run.started" }],
      runs: [{ runId: "run-126" }],
    });
    expect(requests).toEqual([
      { url: "/api/health", method: "GET" },
      { url: "/api/config", method: "GET" },
      { url: "/api/repos", method: "GET" },
      { url: "/api/activity", method: "GET" },
      { url: "/api/runs", method: "GET" },
    ]);
  });

  it("[UC-ADMIN-03-S01] [UC-ADMIN-03-S04] renders daemon, runtime, useful paths, watched repositories, activity, and recent runs", () => {
    const html = renderToStaticMarkup(
      <AdminHomeContent
        data={{
          health: {
            daemon: {
              status: "running",
              state: {
                pid: 321,
                startedAt: "2026-05-24T13:00:00.000Z",
                stdoutPath: "/state/daemon/stdout.log",
                stderrPath: "/state/daemon/stderr.log",
                statePath: "/state/daemon/daemon.json",
              },
            },
            runtime: {
              runtime: "codex",
              available: true,
              message: "codex is available.",
            },
          },
          config: {
            path: "/state/config.yml",
          },
          repositories: [{ repository: "fankaidev/grovie", label: "grovie" }],
          activity: [{
            timestamp: "2026-05-24T13:01:00.000Z",
            type: "run.started",
            message: "Starting fankaidev/grovie#126 for coco@kai-mini.",
            repository: "fankaidev/grovie",
            issueNumber: 126,
            agentId: "coco@kai-mini",
          }],
          runs: [{
            ...baseRun("run-126"),
            repository: "fankaidev/grovie",
            issueNumber: 126,
            agentId: "coco@kai-mini",
            runtime: "codex",
            branchName: "grovie/issue-126",
            startedAt: "2026-05-24T13:02:00.000Z",
          }],
        }}
      />,
    );

    expect(html).toContain("running pid 321");
    expect(html).toContain("codex: available");
    expect(html).toContain("/state/config.yml");
    expect(html).toContain("/state/daemon/stdout.log");
    expect(html).toContain("fankaidev/grovie");
    expect(html).toContain("grovie");
    expect(html).toContain("run.started");
    expect(html).toContain("Starting fankaidev/grovie#126");
    expect(html).toContain("#126");
    expect(html).toContain("coco@kai-mini");
    expect(html).toContain("run-126");
    expect(html).toContain("/runs/run-126");
  });
});

describe("admin web run detail route", () => {
  it("[UC-ADMIN-03-S02] [UC-ADMIN-04-S04] renders run identity, paths, events, result links, and ANSI logs", () => {
    const html = renderToStaticMarkup(
      <RunDetailContent
        state={{
          status: "ready",
          run: {
            runId: "run-1",
            runDir: "/state/runs/run-1",
            repository: "fankaidev/grovie",
            issueNumber: 123,
            agentId: "coco@kai-mini",
            runtime: "codex",
            status: "running",
            branchName: "grovie/issue-123",
            localBranchName: "issue-123",
            repositoryCachePath: "/state/repos/fankaidev/grovie.git",
            worktreePath: "/state/worktrees/run-1",
            stdoutPath: "/state/runs/run-1/stdout.log",
            stderrPath: "/state/runs/run-1/stderr.log",
            promptPath: "/state/runs/run-1/prompt.md",
            taskPath: "/state/runs/run-1/task.json",
            startedAt: "2026-05-24T13:00:00.000Z",
            lastEventTime: "2026-05-24T13:01:00.000Z",
            lastEventType: "comment.created",
            runRequest: {
              reason: "resume",
              sourceRunId: "source-run",
            },
            resultLinks: ["https://github.com/fankaidev/grovie/pull/134"],
            events: [],
          },
          events: [
            {
              timestamp: "2026-05-24T13:01:00.000Z",
              type: "comment.created",
              data: {
                url: "https://github.com/fankaidev/grovie/issues/123#issuecomment-1",
              },
            },
          ],
          stdout: {
            stream: "stdout",
            path: "/state/runs/run-1/stdout.log",
            content: "\u001b[31mred stdout\u001b[0m\n",
          },
          stderr: {
            stream: "stderr",
            path: "/state/runs/run-1/stderr.log",
            content: "plain stderr\n",
          },
        }}
        cancelState={{ status: "idle" }}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain("fankaidev/grovie#123");
    expect(html).toContain("coco@kai-mini");
    expect(html).toContain("resume; source run source-run");
    expect(html).toContain("grovie/issue-123");
    expect(html).toContain("/state/worktrees/run-1");
    expect(html).toContain("prompt.md");
    expect(html).toContain("task.json");
    expect(html).toContain("https://github.com/fankaidev/grovie/pull/134");
    expect(html).toContain("comment.created");
    expect(html).toContain("stdout");
    expect(html).toContain("stderr");
    expect(html).toContain("ansi-red");
    expect(html).toContain("red stdout");
    expect(html).toContain("plain stderr");
    expect(html).toContain("Cancel run");
  });

  it("[UC-ADMIN-03-S03] routes missing run detail paths to a React not-found state", async () => {
    const fetcher = async () => jsonResponse(404, {
      error: "not_found",
      message: "Run not found.",
    });

    expect(readRoute("/runs/run-1")).toEqual({
      name: "run-detail",
      runId: "run-1",
    });
    await expect(loadRunDetail("missing", fetcher as typeof fetch)).resolves.toEqual({
      status: "not-found",
      message: "Run not found.",
    });
  });

  it("[UC-ADMIN-03-S02] fetches run detail, events, stdout, and stderr from existing admin APIs", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
      });

      if (url === "/api/runs/run-1") {
        return jsonResponse(200, {
          run: baseRun("run-1"),
        });
      }

      if (url === "/api/runs/run-1/events") {
        return jsonResponse(200, {
          runId: "run-1",
          events: [{ type: "runtime.started" }],
        });
      }

      if (url === "/api/runs/run-1/logs/stdout") {
        return jsonResponse(200, {
          runId: "run-1",
          stream: "stdout",
          path: "/state/runs/run-1/stdout.log",
          content: "stdout\n",
        });
      }

      if (url === "/api/runs/run-1/logs/stderr") {
        return jsonResponse(200, {
          runId: "run-1",
          stream: "stderr",
          path: "/state/runs/run-1/stderr.log",
          content: "stderr\n",
        });
      }

      return jsonResponse(404, {
        error: "not_found",
      });
    };

    await expect(loadRunDetail("run-1", fetcher as typeof fetch)).resolves.toMatchObject({
      status: "ready",
      run: {
        runId: "run-1",
      },
      events: [{ type: "runtime.started" }],
      stdout: {
        content: "stdout\n",
      },
      stderr: {
        content: "stderr\n",
      },
    });
    expect(requests).toEqual([
      { url: "/api/runs/run-1", method: "GET" },
      { url: "/api/runs/run-1/events", method: "GET" },
      { url: "/api/runs/run-1/logs/stdout", method: "GET" },
      { url: "/api/runs/run-1/logs/stderr", method: "GET" },
    ]);
  });

  it("[UC-ADMIN-05-S01] [UC-ADMIN-05-S04] posts cancel requests and reports not-cancelable states", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
      });

      return jsonResponse(409, {
        error: "not_cancelable",
        message: "Run run-1 is succeeded; only active local runs can be canceled.",
      });
    };

    expect(isCancelableRun("running")).toBe(true);
    expect(isCancelableRun("succeeded")).toBe(false);
    await expect(cancelRunRequest("run-1", fetcher as typeof fetch)).resolves.toEqual({
      ok: false,
      message: "Run run-1 is succeeded; only active local runs can be canceled.",
    });
    expect(requests).toEqual([
      { url: "/api/runs/run-1/cancel", method: "POST" },
    ]);
  });
});

function baseRun(runId: string) {
  return {
    runId,
    runDir: `/state/runs/${runId}`,
    status: "running" as const,
    stdoutPath: `/state/runs/${runId}/stdout.log`,
    stderrPath: `/state/runs/${runId}/stderr.log`,
    promptPath: `/state/runs/${runId}/prompt.md`,
    taskPath: `/state/runs/${runId}/task.json`,
    resultLinks: [],
    events: [],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
