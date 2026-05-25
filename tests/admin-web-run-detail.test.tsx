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
              command: ["grovie", "daemon", "run"],
              startedAt: "2026-05-24T13:00:00.000Z",
              stdoutPath: "/state/daemon/stdout.log",
              stderrPath: "/state/daemon/stderr.log",
              statePath: "/state/daemon/daemon.json",
            },
          },
          runtimes: [
            {
              runtime: "codex",
              command: "codex",
              available: true,
              message: "codex is available.",
            },
            {
              runtime: "pi",
              command: "pi",
              available: false,
              message: "pi command not found.",
            },
          ],
          agents: [
            {
              agentId: "codex@kai-mini",
              name: "codex",
              machineId: "kai-mini",
              runtime: "codex",
              args: [],
              envKeys: [],
              availability: {
                runtime: "codex",
                command: "codex",
                available: true,
                message: "codex is available.",
              },
            },
            {
              agentId: "pi@kai-mini",
              name: "pi",
              machineId: "kai-mini",
              runtime: "pi",
              args: [],
              envKeys: [],
              availability: {
                runtime: "pi",
                command: "pi",
                available: false,
                message: "pi command not found.",
              },
            },
          ],
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
          }, {
            timestamp: "2026-05-24T13:00:00.000Z",
            type: "daemon.started",
            message: "Daemon started.",
            repository: "fankaidev/grovie",
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
      },
      config: {
        path: "/state/config.yml",
      },
      repositories: [{ repository: "fankaidev/grovie", label: "grovie" }],
      activity: expect.arrayContaining([
        expect.objectContaining({ type: "run.started" }),
        expect.objectContaining({ type: "daemon.started" }),
      ]),
      runs: [{ runId: "run-126" }],
    });
    expect(data.health.runtimes).toEqual(expect.arrayContaining([expect.objectContaining({ runtime: "codex", available: true })]));
    expect(requests).toEqual([
      { url: "/api/health", method: "GET" },
      { url: "/api/config", method: "GET" },
      { url: "/api/repos", method: "GET" },
      { url: "/api/activity", method: "GET" },
      { url: "/api/runs", method: "GET" },
    ]);
  });

  it("[UC-ADMIN-03-S01] [UC-ADMIN-03-S04] [UC-ADMIN-03-S06] renders daemon, runtime, useful paths, watched repositories, activity, and grouped recent runs", () => {
    const html = renderToStaticMarkup(
      <AdminHomeContent
        data={{
          health: {
            ok: true,
            daemon: {
              status: "running",
              state: {
                pid: 321,
                command: ["grovie", "daemon", "run"],
                startedAt: "2026-05-24T13:00:00.000Z",
                stdoutPath: "/state/daemon/stdout.log",
                stderrPath: "/state/daemon/stderr.log",
                statePath: "/state/daemon/daemon.json",
              },
            },
            runtimes: [
              {
                runtime: "codex",
                command: "codex",
                available: true,
                message: "codex is available.",
              },
              {
                runtime: "pi",
                command: "pi",
                available: false,
                message: "pi command not found.",
              },
            ],
            agents: [
              {
                agentId: "codex@kai-mini",
                name: "codex",
                machineId: "kai-mini",
                runtime: "codex",
                args: [],
                envKeys: [],
                availability: {
                  runtime: "codex",
                  command: "codex",
                  available: true,
                  message: "codex is available.",
                },
              },
              {
                agentId: "pi@kai-mini",
                name: "pi",
                machineId: "kai-mini",
                runtime: "pi",
                args: [],
                envKeys: [],
                availability: {
                  runtime: "pi",
                  command: "pi",
                  available: false,
                  message: "pi command not found.",
                },
              },
            ],
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
          }, {
            timestamp: "2026-05-24T13:00:00.000Z",
            type: "daemon.started",
            message: "Daemon started.",
            repository: "fankaidev/grovie",
          }],
          runs: [{
            ...baseRun("run-126"),
            repository: "fankaidev/grovie",
            issueNumber: 126,
            agentId: "coco@kai-mini",
            runtime: "codex",
            branchName: "grovie/issue-126",
            startedAt: "2026-05-24T13:02:00.000Z",
            endedAt: "2026-05-24T13:05:00.000Z",
            status: "succeeded",
            resultLinks: ["https://github.com/fankaidev/grovie/pull/140"],
          }, {
            ...baseRun("run-126-retry"),
            repository: "fankaidev/grovie",
            issueNumber: 126,
            agentId: "coco@kai-mini",
            runtime: "codex",
            branchName: "grovie/issue-126",
            startedAt: "2026-05-24T13:06:00.000Z",
            status: "running",
          }],
        }}
      />,
    );

    expect(html).toContain("PID");
    expect(html).toContain("321");
    expect(html).not.toContain("Admin console status");
    expect(html).toContain("codex@kai-mini");
    expect(html).toContain("command");
    expect(html).toContain("pi");
    expect(html).toContain("pi command not found.");
    expect(html).toContain("/state/config.yml");
    expect(html).toContain("/state/daemon/stdout.log");
    expect(html).toContain("fankaidev/grovie");
    expect(html).toContain("grovie");
    expect(html).toContain("run.started");
    expect(html).toContain("Starting fankaidev/grovie#126");
    expect(html).toContain("daemon.started");
    expect(html).toContain("Daemon started.");
    expect(html).toContain("<td>none</td>");
    expect(html).not.toContain("<td>(none)</td><td>(none)</td>");
    expect(html).toContain("#126");
    expect(html).toContain("coco@kai-mini");
    expect(html).toContain("2 total");
    expect(html).toContain("1 running");
    expect(html).toContain("1 succeeded");
    expect(html).toContain("run-126");
    expect(html).toContain("run-126-retry");
    expect(html).toContain("/runs/run-126");
    expect(html).toContain("PR #140");
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
            runId: "run-1",
            stream: "stdout",
            path: "/state/runs/run-1/stdout.log",
            content: "\u001b[31mred stdout\u001b[0m\n",
          },
          stderr: {
            runId: "run-1",
            stream: "stderr",
            path: "/state/runs/run-1/stderr.log",
            content: "plain stderr\n",
          },
          stdoutTranscript: {
            runId: "run-1",
            stream: "stdout",
            path: "/state/runs/run-1/stdout.log",
            transcript: {
              runtime: "codex",
              recognized: false,
              message: "stdout is not recognized as Codex JSONL. Use Raw stdout to inspect the original output.",
              entries: [],
            },
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
    expect(html).toContain("Raw stdout");
    expect(html).toContain("Readable transcript");
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

  it("[UC-ADMIN-02-S08] [UC-ADMIN-03-S02] [UC-ADMIN-04-S06] fetches run detail, events, raw logs, and stdout transcript from admin APIs", async () => {
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

      if (url === "/api/runs/run-1/logs/stdout/transcript") {
        return jsonResponse(200, {
          runId: "run-1",
          stream: "stdout",
          path: "/state/runs/run-1/stdout.log",
          transcript: {
            runtime: "codex",
            recognized: true,
            entries: [{ kind: "assistant_message", text: "Readable output" }],
          },
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
      stdoutTranscript: {
        transcript: {
          recognized: true,
        },
      },
    });
    expect(requests).toEqual([
      { url: "/api/runs/run-1", method: "GET" },
      { url: "/api/runs/run-1/events", method: "GET" },
      { url: "/api/runs/run-1/logs/stdout", method: "GET" },
      { url: "/api/runs/run-1/logs/stderr", method: "GET" },
      { url: "/api/runs/run-1/logs/stdout/transcript", method: "GET" },
    ]);
  });

  it("[UC-ADMIN-04-S06] [UC-ADMIN-04-S08] renders recognized stdout as a readable transcript with grouped activity", () => {
    const html = renderToStaticMarkup(
      <RunDetailContent
        state={{
          status: "ready",
          run: baseRun("run-1") as Extract<Parameters<typeof RunDetailContent>[0]["state"], { status: "ready" }>["run"],
          events: [],
          stdout: {
            runId: "run-1",
            stream: "stdout",
            path: "/state/runs/run-1/stdout.log",
            content: "{\"type\":\"turn.started\"}\n",
          },
          stderr: {
            runId: "run-1",
            stream: "stderr",
            path: "/state/runs/run-1/stderr.log",
            content: "",
          },
          stdoutTranscript: {
            runId: "run-1",
            stream: "stdout",
            path: "/state/runs/run-1/stdout.log",
            transcript: {
              runtime: "codex",
              recognized: true,
              entries: [
                { kind: "assistant_message", text: "I will inspect the run." },
                { kind: "command_execution", command: "pnpm check", status: "completed", exitCode: 0 },
                { kind: "command_output", text: "ok\n" },
                { kind: "assistant_message", text: "The run passed." },
              ],
            },
          },
        }}
        cancelState={{ status: "idle" }}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain("Raw stdout");
    expect(html).toContain("Readable transcript");
    expect(html).toContain("Assistant");
    expect(html).toContain("I will inspect the run.");
    expect(html).toContain("Activity");
    expect(html).toContain("2 entries");
    expect(html).toContain("pnpm check");
    expect(html).toContain("ok");
    expect(html).toContain("The run passed.");
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
