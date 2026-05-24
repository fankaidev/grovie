import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrovieConfig } from "../src/config.js";
import { runDaemon, runDaemonCycle, runDaemonForRepositories } from "../src/daemon.js";
import type {
  CreatedComment,
  GitHubGateway,
  GitHubIssue,
  GitHubIssueSummary,
  GitHubRelatedPullRequest,
  IssueReference,
} from "../src/github.js";
import { resolveMachineId } from "../src/identity.js";
import { LocalState } from "../src/local-state.js";
import { inspectQueue } from "../src/queue.js";
import type { RunIssueAsyncInput, RunIssueResult } from "../src/run.js";
import type { AgentRuntime, RuntimeAvailability } from "../src/runtime.js";

const NOW = new Date("2026-05-22T00:00:00Z");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runDaemonCycle", () => {
  it("claims one queued issue, runs it once, and updates the claim", async () => {
    const github = new FakeGitHub([fakeIssue()]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran issue",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran issue",
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.issueReference).toEqual({
      owner: "fankaidev",
      repo: "grovie",
      number: 8,
    });
    expect(github.createdComments[0]).toContain("Grovie daemon task claim active.");
    expect(github.updatedComments.map((comment) => comment.body)).toEqual([
      expect.stringContaining("Grovie daemon task claim active."),
      expect.stringContaining("Grovie daemon task claim released."),
    ]);
  });

  it("[UC-WORKER-01-S04] uses the assigned local agent id as the daemon worker id", async () => {
    const github = new FakeGitHub([fakeIssue()]);
    const machineId = resolveMachineId(hostname());

    await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: () => ({
        exitCode: 0,
      }),
    });

    expect(github.createdComments[0]).toContain(`- Worker: \`default@${machineId}\``);
  });

  it("[UC-WORKER-03-S05] [UC-WORKER-04-S11] reports issues assigned only to another machine as skipped", async () => {
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", "agent:coder@other-machine"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
        "",
        "Skipped assigned issues:",
        "- fankaidev/grovie#8 agent=coder@other-machine reason=assigned to another machine",
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-WORKER-04-S03] skips label-only issues without a local agent assignment", async () => {
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      workerId: `default@${resolveMachineId(hostname())}`,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-WORKER-04-S11] reports handled assigned issues as skipped", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.writeHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `coder@${machineId}`,
      handledThrough: NOW.toISOString(),
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:coder@${machineId}`],
      }),
    ]);

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("run was not expected");
      },
    });

    expect(result.stdout).toContain("Skipped assigned issues:");
    expect(result.stdout).toContain(`- fankaidev/grovie#8 agent=coder@${machineId} reason=no unhandled activity`);
  });

  it("[UC-WORKER-04-S11] reports canceled local assignments as skipped without claiming them", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:coder@${machineId}`, "grovie:cancel"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
        "",
        "Skipped assigned issues:",
        `- fankaidev/grovie#8 agent=coder@${machineId} reason=canceled`,
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-EXECUTION-01-S01] [UC-EXECUTION-02-S09] consumes one manual run request before scheduled issues and preserves request trace", async () => {
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie"],
      }),
    ]);
    localState.enqueueRunRequest({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: "coder@fankai-mac",
      sourceRunId: "failed-run",
      reason: "retry",
      now: NOW,
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran request",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran request",
    });
    expect(runs[0]?.issueReference.number).toBe(8);
    expect(runs[0]?.agentId).toBe("coder@fankai-mac");
    expect(runs[0]?.runRequest).toEqual({
      sourceRunId: "failed-run",
      reason: "retry",
    });
    expect(github.createdComments[0]).toContain("- Worker: `coder@fankai-mac`");
    expect(localState.takeRunRequest("fankaidev/grovie")).toBeUndefined();
  });

  it("[UC-EXECUTION-02-S13] rejects a daemon request for an unconfigured local agent before runtime start", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.enqueueRunRequest({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      reason: "manual",
      now: NOW,
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([fakeIssue()]),
      once: true,
      localState,
      localAgents: [configuredCodexAgent("coder", machineId)],
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: [
        "grovie daemon",
        "",
        `Rejected run request 20260522T000000Z-fankaidev-grovie-issue-8-default-${machineId} for fankaidev/grovie#8: Agent default@${machineId} is not configured locally.`,
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(localState.takeRunRequest("fankaidev/grovie")).toBeUndefined();
  });

  it("[UC-EXECUTION-02-S14] records post-run pull request activity as handled for the same issue-agent", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const relatedPullRequests: GitHubRelatedPullRequest[] = [];
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:coder@${machineId}`],
        updatedAt: "2026-05-22T00:00:00.000Z",
      }),
    ], {
      relatedPullRequests,
      commentNow: () => new Date("2026-05-22T00:00:03.000Z"),
    });

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        relatedPullRequests.push(fakeRelatedPullRequest({
          updatedAt: "2026-05-22T00:00:05.000Z",
        }));

        return {
          exitCode: 0,
          stdout: "created pull request",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "created pull request",
    });
    expect(localState.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `coder@${machineId}`,
    })?.handledThrough).toBe("2026-05-22T00:00:05.000Z");

    const queueResult = inspectQueue({
      repositories: [
        {
          repository: "fankaidev/grovie",
          label: "grovie",
        },
      ],
      github,
      machineId,
      localState,
    });

    expect(queueResult).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          candidates: [
            expect.objectContaining({
              status: "skipped",
              reason: "no unhandled activity",
            }),
          ],
        }),
      ],
    });
  });

  it("[UC-WORKER-04-S03] creates one run for a locally assigned agent with unhandled activity", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:coder@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran coder",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran coder",
    });
    expect(runs).toHaveLength(1);
    expect(github.createdComments[0]).toContain(`- Worker: \`coder@${machineId}\``);
  });

  it("[UC-WORKER-04-S14] skips a machine-local agent label when that agent is not configured", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:default@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localAgents: [configuredCodexAgent("coder", machineId)],
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
        "",
        "Skipped assigned issues:",
        `- fankaidev/grovie#8 agent=default@${machineId} reason=agent not configured locally`,
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-DAEMON-03-S02] resumes an interrupted session before polling new queue items", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "old-run", {
      status: "interrupted",
      resumeEligible: true,
      runId: "old-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    });
    const github = new FakeGitHub([
      fakeIssue({
        reference: fakeReference(8),
        labels: ["grovie"],
      }),
      fakeIssue({
        reference: fakeReference(9),
        labels: ["grovie", `agent:default@${machineId}`, "priority:p0"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "resumed interrupted session",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "resumed interrupted session",
    });
    expect(runs[0]?.issueReference.number).toBe(8);
    expect(runs[0]?.runRequest).toEqual({
      sourceRunId: "old-run",
      reason: "resume",
    });
    expect(readRunMetadata(localState, "old-run").status).toBe("resuming");
  });

  it("[UC-EXECUTION-02-S12] rejects a resumable run whose agent is no longer configured locally", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "old-run", {
      status: "interrupted",
      resumeEligible: true,
      runId: "old-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    });
    const github = new FakeGitHub([
      fakeIssue({
        reference: fakeReference(8),
        labels: ["grovie"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      localAgents: [configuredCodexAgent("coder", machineId)],
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: [
        "grovie daemon",
        "",
        `Skipped resumable run old-run for fankaidev/grovie#8: Agent default@${machineId} is not configured locally.`,
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(readRunMetadata(localState, "old-run")).toMatchObject({
      status: "rejected",
      resumeEligible: false,
      rejectReason: `Agent default@${machineId} is not configured locally.`,
    });
  });

  it("[UC-DAEMON-03-S02] leaves an interrupted run resumable when recovery cannot start", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "old-run", {
      status: "interrupted",
      resumeEligible: true,
      runId: "old-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    });

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([fakeIssue()], { failReadIssueFor: 8 }),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("recovery run was not expected");
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      processed: false,
      stderr: "temporary GitHub read failure",
    });
    expect(readRunMetadata(localState, "old-run")).toMatchObject({
      status: "interrupted",
      resumeEligible: true,
    });
  });

  it("[UC-DAEMON-03-S05] does not auto-resume terminal runs even when metadata still looks active", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "succeeded-run", {
      status: "prepared",
      runId: "succeeded-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    }, [
      {
        timestamp: "2026-05-22T00:00:00.000Z",
        type: "runtime.finished",
        data: { exitCode: 0 },
      },
    ]);

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([]),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("terminal run was not expected to resume");
      },
    });

    expect(result.processed).toBe(false);
  });

  it("[UC-DAEMON-03-S03] recovers active-looking runs left by a force stop", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "active-run", {
      status: "prepared",
      runId: "active-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    });
    localState.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      now: NOW,
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([fakeIssue({ labels: ["grovie"] })]),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "recovered active-looking run",
        };
      },
    });

    expect(result.processed).toBe(true);
    expect(runs[0]?.runRequest).toEqual({
      sourceRunId: "active-run",
      reason: "resume",
    });
    expect(localState.hasExecutionLock?.({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    })).toBe(false);
  });

  it("[UC-DAEMON-03-S01] lets interrupted state win over stop-time runtime failure events", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "interrupted-run", {
      status: "interrupted",
      resumeEligible: true,
      runId: "interrupted-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    }, [
      {
        timestamp: "2026-05-22T00:00:00.000Z",
        type: "run.interrupted",
        data: { resumeEligible: true },
      },
      {
        timestamp: "2026-05-22T00:00:01.000Z",
        type: "runtime.finished",
        data: { exitCode: 143 },
      },
      {
        timestamp: "2026-05-22T00:00:02.000Z",
        type: "run.failed",
        data: { exitCode: 143 },
      },
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([fakeIssue({ labels: ["grovie"] })]),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "resumed stop-time failure",
        };
      },
    });

    expect(result.processed).toBe(true);
    expect(runs[0]?.runRequest).toEqual({
      sourceRunId: "interrupted-run",
      reason: "resume",
    });
  });

  it("[UC-DAEMON-03-S03] does not recover a run while its runtime pid is still live", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "active-run", {
      status: "interrupted",
      resumeEligible: true,
      runId: "active-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      runtimePid: process.pid,
    });

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([]),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("live runtime was not expected to duplicate");
      },
    });

    expect(result.processed).toBe(false);
  });

  it("[UC-DAEMON-03-S04] does not auto-resume canceled runs", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "canceled-run", {
      status: "interrupted",
      resumeEligible: true,
      runId: "canceled-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    });
    localState.requestRunCancellation({
      runId: "canceled-run",
      reason: "User canceled the run.",
      now: NOW,
    });

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([]),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("canceled run was not expected to resume");
      },
    });

    expect(result.processed).toBe(false);
  });

  it("[UC-DAEMON-03-S05] does not auto-resume failed runs without an explicit retry or rerun", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    writeRunMetadata(localState, "failed-run", {
      status: "failed",
      resumeEligible: true,
      runId: "failed-run",
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    });

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([]),
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("failed run was not expected to resume");
      },
    });

    expect(result.processed).toBe(false);
  });

  it("[UC-WORKER-04-S09] picks runnable assigned issues by priority before GitHub list order", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        reference: fakeReference(8),
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p2"],
      }),
      fakeIssue({
        reference: fakeReference(9),
        labels: ["grovie", `agent:coder@${machineId}`],
      }),
      fakeIssue({
        reference: fakeReference(10),
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p0"],
      }),
      fakeIssue({
        reference: fakeReference(11),
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p1"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran prioritized issue",
        };
      },
    });

    expect(result.processed).toBe(true);
    expect(runs[0]?.issueReference.number).toBe(10);
  });

  it("[UC-WORKER-04-S09] uses older activity first within the same priority", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        reference: fakeReference(8),
        updatedAt: "2026-05-22T00:00:05.000Z",
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p1"],
      }),
      fakeIssue({
        reference: fakeReference(9),
        updatedAt: "2026-05-22T00:00:01.000Z",
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p1"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran older activity",
        };
      },
    });

    expect(result.processed).toBe(true);
    expect(runs[0]?.issueReference.number).toBe(9);
  });

  it("[UC-WORKER-04-S10] skips a blocked high-priority issue and runs a lower-priority candidate", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `coder@${machineId}`,
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        reference: fakeReference(8),
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p0"],
      }),
      fakeIssue({
        reference: fakeReference(9),
        labels: ["grovie", `agent:coder@${machineId}`, "priority:p1"],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran lower priority",
        };
      },
    });

    expect(result.processed).toBe(true);
    expect(runs[0]?.issueReference.number).toBe(9);
  });

  it("[UC-EXECUTION-03-S02] skips assigned runs when Codex is unavailable", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:coder@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      runtime: fakeRuntime({
        available: false,
        message: "codex command not found",
      }),
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "Skipped assigned runs because Codex runtime is unavailable: codex command not found",
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-WORKER-04-S07] creates a reviewer run before a related pull request exists", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:reviewer@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "reviewer decided no action was needed",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "reviewer decided no action was needed",
    });
    expect(runs).toHaveLength(1);
    expect(github.createdComments[0]).toContain(`- Worker: \`reviewer@${machineId}\``);
  });

  it("[UC-WORKER-04-S01] refuses to start when a live daemon lock exists", async () => {
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const existingLock = localState.acquireDaemonLock(resolveMachineId(hostname()), NOW);

    expect(existingLock.ok).toBe(true);

    await expect(runDaemon({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github: new FakeGitHub([]),
      once: true,
      localState,
      now: () => NOW,
    })).resolves.toEqual({
      exitCode: 1,
      stderr: `Grovie daemon already appears to be running for machine ${resolveMachineId(hostname())} with pid ${process.pid}.`,
    });
  });

  it("[UC-WORKER-04-S05] [UC-WORKER-04-S11] reports an assigned issue skipped by a local execution lock", async () => {
    const github = new FakeGitHub([fakeIssue()]);
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${resolveMachineId(hostname())}`,
      now: NOW,
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
        "",
        "Skipped assigned issues:",
        `- fankaidev/grovie#8 agent=default@${resolveMachineId(hostname())} reason=active local execution lock`,
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-EXECUTION-02-S03] creates a run when issue activity is newer than the handled cursor", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.writeHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      handledThrough: "2026-05-22T00:00:00.000Z",
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        comments: [
          fakeComment({
            id: 10,
            updatedAt: "2026-05-22T00:00:01.000Z",
          }),
        ],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran new activity",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran new activity",
    });
    expect(runs).toHaveLength(1);
  });

  it("[UC-GITHUB-02-S02] creates a run when related pull request activity is newer than the handled cursor", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.writeHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      handledThrough: "2026-05-22T00:00:01.000Z",
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        updatedAt: "2026-05-22T00:00:00.000Z",
      }),
    ], {
      relatedPullRequests: [
        fakeRelatedPullRequest({
          updatedAt: "2026-05-22T00:00:02.000Z",
        }),
      ],
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran related PR activity",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran related PR activity",
    });
    expect(runs).toHaveLength(1);
    expect(localState.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    })?.handledThrough).toBe("2026-05-22T00:00:02.000Z");
  });

  it("[UC-EXECUTION-02-S03] creates a run when the issue itself is updated after the handled cursor", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.writeHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      handledThrough: "2026-05-22T00:00:00.000Z",
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        updatedAt: "2026-05-22T00:00:01.000Z",
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran issue update",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran issue update",
    });
    expect(runs).toHaveLength(1);
  });

  it("[UC-EXECUTION-02-S04] [UC-WORKER-04-S11] reports unchanged issue activity skipped by the handled cursor", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.writeHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
      handledThrough: "2026-05-22T00:00:01.000Z",
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        comments: [
          fakeComment({
            updatedAt: "2026-05-22T00:00:01.000Z",
          }),
        ],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: false,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
        "",
        "Skipped assigned issues:",
        `- fankaidev/grovie#8 agent=default@${machineId} reason=no unhandled activity`,
      ].join("\n"),
    });
    expect(runs).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("[UC-WORKER-04-S03] updates the handled cursor after terminal run completion", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const github = new FakeGitHub([
      fakeIssue({
        comments: [
          fakeComment({
            updatedAt: "2026-05-22T00:00:02.000Z",
          }),
        ],
      }),
    ]);

    await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => ({
        exitCode: 0,
      }),
    });

    expect(localState.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    })?.handledThrough).toBe("2026-05-22T00:00:02.000Z");
  });

  it("[UC-EXECUTION-02-S04] [UC-WORKER-04-S04] ignores Grovie claim comments when checking the handled cursor", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const github = new FakeGitHub([
      fakeIssue({
        updatedAt: "2026-05-22T00:00:00.000Z",
        comments: [
          fakeComment({
            updatedAt: "2026-05-22T00:00:01.000Z",
          }),
        ],
      }),
    ], { commentNow: () => new Date("2026-05-22T00:00:03.000Z") });

    await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => ({
        exitCode: 0,
      }),
    });

    const secondResult = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("second run was not expected");
      },
    });

    expect(localState.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    })?.handledThrough).toBe("2026-05-22T00:00:01.000Z");
    expect(secondResult.processed).toBe(false);
  });

  it("[UC-EXECUTION-02-S03] creates another run when a user comment arrives during execution", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const issue = fakeIssue({
      updatedAt: "2026-05-22T00:00:00.000Z",
      comments: [
        fakeComment({
          id: 10,
          updatedAt: "2026-05-22T00:00:01.000Z",
        }),
      ],
    });
    const github = new FakeGitHub([issue]);
    const runs: RunIssueAsyncInput[] = [];

    await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        issue.comments.push(
          fakeComment({
            id: 42,
            body: "Please also update the CLI help.",
            updatedAt: "2026-05-22T00:00:02.000Z",
          }),
        );
        issue.updatedAt = "2026-05-22T00:00:02.000Z";
        return {
          exitCode: 0,
        };
      },
    });

    const secondResult = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran user activity",
        };
      },
    });

    expect(localState.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    })?.handledThrough).toBe("2026-05-22T00:00:02.000Z");
    expect(secondResult).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran user activity",
    });
    expect(runs).toHaveLength(2);
  });

  it("[UC-EXECUTION-02-S03] creates another run when the issue is edited during execution", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    const issue = fakeIssue({
      updatedAt: "2026-05-22T00:00:00.000Z",
      comments: [
        fakeComment({
          id: 10,
          updatedAt: "2026-05-22T00:00:01.000Z",
        }),
      ],
    });
    const github = new FakeGitHub([issue], { commentNow: () => new Date("2026-05-22T00:00:03.000Z") });
    const runs: RunIssueAsyncInput[] = [];

    await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        issue.body = "Run queued work and update CLI help.";
        issue.updatedAt = "2026-05-22T00:00:02.000Z";
        return {
          exitCode: 0,
        };
      },
    });

    const secondResult = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran edited issue",
        };
      },
    });

    expect(localState.readHandledCursor({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `default@${machineId}`,
    })?.handledThrough).toBe("2026-05-22T00:00:01.000Z");
    expect(secondResult).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran edited issue",
    });
    expect(runs).toHaveLength(2);
  });

  it("[UC-GITHUB-01-S05] ignores visible claim comments when choosing local execution", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:default@${machineId}`],
        comments: [
          fakeComment({
            id: 99,
            body: '<!-- grovie:claim {"workerId":"other","status":"active"} -->\nGrovie daemon task claim active.',
          }),
        ],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran despite visible claim",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran despite visible claim",
    });
    expect(runs).toHaveLength(1);
    expect(github.createdComments[0]).toContain(`- Worker: \`default@${machineId}\``);
  });

  it("[UC-WORKER-04-S06] uses independent local agent locks for assigned agents on one issue", async () => {
    const machineId = resolveMachineId(hostname());
    const localState = new LocalState({ paths: { root: createTmpDir() } });
    localState.acquireExecutionLock({
      repository: "fankaidev/grovie",
      issueNumber: 8,
      agentId: `coder@${machineId}`,
      now: NOW,
    });
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:coder@${machineId}`, `agent:reviewer@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      localState,
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran reviewer",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "ran reviewer",
    });
    expect(runs).toHaveLength(1);
    expect(github.createdComments[0]).toContain(`- Worker: \`reviewer@${machineId}\``);
  });

  it("marks a claimed issue canceled when a cancel comment is visible before runtime start", async () => {
    const github = new FakeGitHub([fakeIssue()], {
      addCancelAfterClaim: true,
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: [
        "grovie daemon",
        "",
        "Canceled fankaidev/grovie#8 before runtime start.",
      ].join("\n"),
    });
    expect(runs).toHaveLength(0);
    expect(github.updatedComments.at(-1)?.body).toContain("Grovie daemon task claim released.");
    expect(github.updatedComments.at(-1)?.body).toContain("- Note: Session canceled before runtime start.");
  });

  it("updates heartbeat and marks canceled when cancellation appears during runtime", async () => {
    const github = new FakeGitHub([fakeIssue()], {
      addCancelOnRunningUpdate: true,
    });
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: async (input) => {
        runs.push(input);
        await input.monitor?.onHeartbeat?.({} as never);

        return {
          exitCode: 0,
          stdout: "canceled",
          canceled: (await input.monitor?.shouldCancel?.({} as never)) === true ? true : undefined,
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      processed: true,
      stdout: "canceled",
      canceled: true,
    });
    expect(runs).toHaveLength(1);
    expect(github.updatedComments.map((comment) => comment.body)).toEqual([
      expect.stringContaining("Grovie daemon task claim active."),
      expect.stringContaining("Grovie daemon task claim active."),
      expect.stringContaining("Grovie daemon task claim released."),
    ]);
  });

  it("marks a claimed issue failed when the issue runner fails", async () => {
    const github = new FakeGitHub([fakeIssue()]);

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: () => ({
        exitCode: 1,
        stderr: "runtime failed",
      }),
    });

    expect(result).toEqual({
      exitCode: 1,
      processed: true,
      stderr: "runtime failed",
    });
    expect(github.updatedComments.map((comment) => comment.body)).toEqual([
      expect.stringContaining("Grovie daemon task claim active."),
      expect.stringContaining("Grovie daemon task claim released."),
    ]);
    expect(github.updatedComments.at(-1)?.body).toContain(
      "- Note: Session failed. See the Grovie result comment and local run logs.",
    );
  });

  it("[UC-GITHUB-01-S05] treats stale visible claims as non-authoritative summaries", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["grovie", `agent:default@${machineId}`],
        comments: [
          fakeComment({
            id: 99,
            body: '<!-- grovie:claim {"workerId":"other","status":"active"} -->\nGrovie daemon task claim active.',
            updatedAt: "2026-05-21T00:00:00Z",
          }),
        ],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonCycle({
      repository: "fankaidev/grovie",
      label: "grovie",
      config: defaultConfig(),
      configPath: "/project/.grovie.yml",
      github,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran issue",
        };
      },
    });

    expect(result.processed).toBe(true);
    expect(runs).toHaveLength(1);
    expect(github.createdComments[0]).toContain("Grovie daemon task claim active.");
  });

  it("[UC-WORKER-06-S14] daemon run owns the enabled admin console in the same daemon process", async () => {
    const port = await getAvailablePort();
    const github = new FakeGitHub([fakeIssue()]);
    const localState = new LocalState({ paths: { root: createTmpDir() } });

    const result = await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/grovie",
          label: "grovie",
        },
      ],
      config: defaultConfig(),
      configPath: "built-in defaults",
      github,
      runtime: fakeRuntime(),
      localState,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      adminConsole: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      issueRunner: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: true,
          runtime: {
            runtime: "codex",
            available: true,
          },
        });

        return {
          exitCode: 0,
          stdout: "ran issue",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ran issue",
    });
  });

  it("[UC-WORKER-06-S15] daemon run stops the admin console when the daemon stops", async () => {
    const port = await getAvailablePort();
    const github = new FakeGitHub([fakeIssue()]);
    const localState = new LocalState({ paths: { root: createTmpDir() } });

    await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/grovie",
          label: "grovie",
        },
      ],
      config: defaultConfig(),
      configPath: "built-in defaults",
      github,
      runtime: fakeRuntime(),
      localState,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      adminConsole: {
        enabled: true,
        host: "127.0.0.1",
        port,
      },
      issueRunner: () => ({
        exitCode: 0,
      }),
    });

    await expectPortCanBind(port);
  });

  it("[UC-ADMIN-01-S06] disabled admin console does not bind a web port during daemon startup", async () => {
    const port = await getAvailablePort();
    const github = new FakeGitHub([fakeIssue()]);
    const localState = new LocalState({ paths: { root: createTmpDir() } });

    const result = await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/grovie",
          label: "grovie",
        },
      ],
      config: defaultConfig(),
      configPath: "built-in defaults",
      github,
      runtime: fakeRuntime(),
      localState,
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      adminConsole: {
        enabled: false,
        host: "127.0.0.1",
        port,
      },
      issueRunner: async () => {
        await expectPortCanBind(port);

        return {
          exitCode: 0,
          stdout: "ran issue",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ran issue",
    });
  });

  it("[UC-ADMIN-01-S04] daemon startup fails clearly when the enabled admin console port is unavailable", async () => {
    const port = await getAvailablePort();
    const occupied = createServer();

    await new Promise<void>((resolve) => occupied.listen(port, "127.0.0.1", resolve));

    try {
      const result = await runDaemonForRepositories({
        repositories: [
          {
            repository: "fankaidev/grovie",
            label: "grovie",
          },
        ],
        config: defaultConfig(),
        configPath: "built-in defaults",
        github: new FakeGitHub([fakeIssue()]),
        runtime: fakeRuntime(),
        localState: new LocalState({ paths: { root: createTmpDir() } }),
        once: true,
        workerId: "worker-1",
        now: () => NOW,
        adminConsole: {
          enabled: true,
          host: "127.0.0.1",
          port,
        },
      });

      expect(result).toEqual({
        exitCode: 1,
        stderr: `Admin console port ${port} is unavailable on 127.0.0.1.`,
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("[UC-WORKER-04-S08] checks multiple watched repositories sequentially until it finds queued work", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        reference: {
          owner: "fankaidev",
          repo: "other",
          number: 5,
        },
        labels: ["ready", `agent:default@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/grovie",
          label: "grovie",
        },
        {
          repository: "fankaidev/other",
          label: "ready",
        },
      ],
      config: defaultConfig(),
      configPath: "built-in defaults",
      github,
      runtime: fakeRuntime(),
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran other issue",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ran other issue",
    });
    expect(runs[0]?.issueReference).toEqual({
      owner: "fankaidev",
      repo: "other",
      number: 5,
    });
  });

  it("[UC-WORKER-04-S12] uses repo-local daemon policy for queue label and run config", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        labels: ["ready", `agent:default@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];
    const config = {
      ...defaultConfig(),
      runtime: {
        default: "claude-code" as const,
      },
      queue: {
        label: "ready",
      },
      branches: {
        prefix: "issue/",
      },
    };

    const result = await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/grovie",
        },
      ],
      repositoryConfigLoader: () => ({
        path: "fankaidev/grovie:.grovie.yml",
        config,
      }),
      config: defaultConfig(),
      configPath: "built-in defaults",
      github,
      runtime: fakeRuntime(),
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran repo policy issue",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ran repo policy issue",
    });
    expect(runs[0]?.config).toMatchObject({
      runtime: {
        default: "claude-code",
      },
      queue: {
        label: "ready",
      },
      branches: {
        prefix: "issue/",
      },
    });
    expect(runs[0]?.configPath).toBe("fankaidev/grovie:.grovie.yml");
  });

  it("[UC-WORKER-04-S13] reports invalid repo-local policy without blocking unrelated watched repositories", async () => {
    const machineId = resolveMachineId(hostname());
    const github = new FakeGitHub([
      fakeIssue({
        reference: {
          owner: "fankaidev",
          repo: "other",
          number: 5,
        },
        labels: ["grovie", `agent:default@${machineId}`],
      }),
    ]);
    const runs: RunIssueAsyncInput[] = [];

    const result = await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/bad",
        },
        {
          repository: "fankaidev/other",
        },
      ],
      repositoryConfigLoader: (repository) => {
        if (repository === "fankaidev/bad") {
          throw new Error("Invalid fankaidev/bad:.grovie.yml:\n- runtime.default: Invalid option");
        }

        return {
          config: defaultConfig(),
        };
      },
      config: defaultConfig(),
      configPath: "built-in defaults",
      github,
      runtime: fakeRuntime(),
      once: true,
      workerId: "worker-1",
      now: () => NOW,
      issueRunner: (input) => {
        runs.push(input);
        return {
          exitCode: 0,
          stdout: "ran unrelated repo",
        };
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ran unrelated repo",
      stderr: [
        "grovie daemon",
        "",
        "Skipped fankaidev/bad: Invalid fankaidev/bad:.grovie.yml:",
        "- runtime.default: Invalid option",
      ].join("\n"),
    });
    expect(runs[0]?.repository).toBe("fankaidev/other");
  });

  it("[UC-WORKER-04-S13] fails clearly when every watched repository has invalid repo-local policy", async () => {
    const result = await runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/bad",
        },
      ],
      repositoryConfigLoader: () => {
        throw new Error("Invalid fankaidev/bad:.grovie.yml:\n- runtime.default: Invalid option");
      },
      config: defaultConfig(),
      configPath: "built-in defaults",
      github: new FakeGitHub([]),
      once: true,
      now: () => NOW,
      issueRunner: () => {
        throw new Error("issue runner was not expected");
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: [
        "grovie daemon",
        "",
        "Skipped fankaidev/bad: Invalid fankaidev/bad:.grovie.yml:",
        "- runtime.default: Invalid option",
      ].join("\n"),
    });
  });

  it("[UC-WORKER-04-S13] reports invalid repo-local policy during long-running daemon cycles", async () => {
    const reports: RunIssueResult[] = [];
    const stop = new Error("stop after first cycle");

    await expect(runDaemonForRepositories({
      repositories: [
        {
          repository: "fankaidev/bad",
        },
      ],
      repositoryConfigLoader: () => {
        throw new Error("Invalid fankaidev/bad:.grovie.yml:\n- runtime.default: Invalid option");
      },
      config: defaultConfig(),
      configPath: "built-in defaults",
      github: new FakeGitHub([]),
      once: false,
      now: () => NOW,
      sleep: () => {
        throw stop;
      },
      onCycleResult: (result) => {
        reports.push(result);
      },
      issueRunner: () => {
        throw new Error("issue runner was not expected");
      },
    })).rejects.toThrow("stop after first cycle");

    expect(reports).toEqual([
      {
        exitCode: 1,
        processed: false,
        stderr: [
          "grovie daemon",
          "",
          "Skipped fankaidev/bad: Invalid fankaidev/bad:.grovie.yml:",
          "- runtime.default: Invalid option",
        ].join("\n"),
      },
    ]);
  });
});

class FakeGitHub implements GitHubGateway {
  readonly createdComments: string[] = [];
  readonly updatedComments: Array<{ commentId: number; body: string }> = [];
  private nextCommentId = 1;

  constructor(
    private readonly issues: GitHubIssue[],
    private readonly options: {
      addCancelAfterClaim?: boolean;
      addCancelOnRunningUpdate?: boolean;
      commentNow?: () => Date;
      failReadIssueFor?: number;
      relatedPullRequests?: GitHubRelatedPullRequest[];
    } = {},
  ) {}

  getAuthenticatedUser(): ReturnType<GitHubGateway["getAuthenticatedUser"]> {
    throw new Error("getAuthenticatedUser was not expected");
  }

  listOpenIssues(repository: string, label: string): ReturnType<GitHubGateway["listOpenIssues"]> {
    const summaries: GitHubIssueSummary[] = this.issues
      .filter((issue) => `${issue.reference.owner}/${issue.reference.repo}` === repository)
      .filter((issue) => issue.state === "open")
      .filter((issue) => issue.labels.includes(label))
      .map((issue) => ({
        reference: issue.reference,
        title: issue.title,
        labels: issue.labels,
      }));

    return {
      ok: true,
      value: summaries,
    };
  }

  readIssue(reference: IssueReference): ReturnType<GitHubGateway["readIssue"]> {
    if (this.options.failReadIssueFor === reference.number) {
      return {
        ok: false,
        error: {
          code: "gh_failed",
          message: "temporary GitHub read failure",
        },
      };
    }

    const issue = this.findIssue(reference);

    return {
      ok: true,
      value: {
        ...issue,
        comments: [...issue.comments],
      },
    };
  }

  addLabels(): ReturnType<GitHubGateway["addLabels"]> {
    throw new Error("addLabels was not expected");
  }

  removeLabel(): ReturnType<GitHubGateway["removeLabel"]> {
    throw new Error("removeLabel was not expected");
  }

  createIssueComment(reference: IssueReference, body: string): ReturnType<GitHubGateway["createIssueComment"]> {
    const id = this.nextCommentId++;
    const issue = this.findIssue(reference);

    this.createdComments.push(body);
    const now = this.options.commentNow?.() ?? NOW;
    issue.comments.push(
      fakeComment({
        id,
        body,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
    );
    issue.updatedAt = now.toISOString();

    if (this.options.addCancelAfterClaim) {
      const cancelNow = this.options.commentNow?.() ?? NOW;
      issue.comments.push(
        fakeComment({
          id: this.nextCommentId++,
          body: "/grovie cancel",
          createdAt: cancelNow.toISOString(),
          updatedAt: cancelNow.toISOString(),
        }),
      );
      issue.updatedAt = cancelNow.toISOString();
    }

    return {
      ok: true,
      value: {
        id,
        body,
        url: `https://github.com/fankaidev/grovie/issues/${reference.number}#issuecomment-${id}`,
      } satisfies CreatedComment,
    };
  }

  updateIssueComment(_repository: string, commentId: number, body: string): ReturnType<GitHubGateway["updateIssueComment"]> {
    this.updatedComments.push({ commentId, body });
    const now = this.options.commentNow?.() ?? NOW;

    for (const issue of this.issues) {
      const comment = issue.comments.find((candidate) => candidate.id === commentId);

      if (comment !== undefined) {
        comment.body = body;
        comment.updatedAt = now.toISOString();
        issue.updatedAt = now.toISOString();
      }

      if (this.options.addCancelOnRunningUpdate === true && body.includes("Grovie daemon task claim active.")) {
        const cancelNow = this.options.commentNow?.() ?? NOW;
        issue.comments.push(
          fakeComment({
            id: this.nextCommentId++,
            body: "/grovie cancel",
            createdAt: cancelNow.toISOString(),
            updatedAt: cancelNow.toISOString(),
          }),
        );
        issue.updatedAt = cancelNow.toISOString();
        this.options.addCancelOnRunningUpdate = false;
      }
    }

    return {
      ok: true,
      value: {
        id: commentId,
        body,
        url: `https://github.com/fankaidev/grovie/issues/8#issuecomment-${commentId}`,
      },
    };
  }

  createPullRequest(): ReturnType<GitHubGateway["createPullRequest"]> {
    throw new Error("createPullRequest was not expected");
  }

  readRelatedPullRequests(): ReturnType<NonNullable<GitHubGateway["readRelatedPullRequests"]>> {
    return {
      ok: true,
      value: this.options.relatedPullRequests ?? [],
    };
  }

  private findIssue(reference: IssueReference): GitHubIssue {
    const issue = this.issues.find(
      (candidate) =>
        candidate.reference.owner === reference.owner &&
        candidate.reference.repo === reference.repo &&
        candidate.reference.number === reference.number,
    );

    if (issue === undefined) {
      throw new Error(`Unexpected issue: ${reference.owner}/${reference.repo}#${reference.number}`);
    }

    return issue;
  }
}

function defaultConfig(): GrovieConfig {
  return {
    version: 1,
    runtime: {
      default: "codex",
    },
    queue: {
      label: "grovie",
    },
    branches: {
      prefix: "grovie/",
    },
    worktrees: {
      cleanup: "on-success",
    },
    pullRequests: {
      create: true,
      draft: false,
    },
    comments: {
      mode: "concise",
    },
    safety: {
      allowDefaultBranchPush: false,
    },
  };
}

function fakeRuntime(availability: Partial<RuntimeAvailability> = {}): AgentRuntime {
  return {
    name: "codex",
    checkAvailability: () => ({
      runtime: "codex",
      command: "codex",
      available: true,
      version: "codex-cli 0.133.0",
      message: "available (codex-cli 0.133.0)",
      ...availability,
    }),
    run: () => {
      throw new Error("runtime run was not expected");
    },
    start: () => {
      throw new Error("runtime start was not expected");
    },
    resume: () => {
      throw new Error("runtime resume was not expected");
    },
  };
}

function fakeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    reference: {
      owner: "fankaidev",
      repo: "grovie",
      number: 8,
    },
    title: "Implement daemon",
    body: "Run queued work.",
    state: "open",
    updatedAt: NOW.toISOString(),
    labels: ["grovie", `agent:default@${resolveMachineId(hostname())}`],
    comments: [],
    defaultBranch: "main",
    ...overrides,
  };
}

function fakeReference(number: number): IssueReference {
  return {
    owner: "fankaidev",
    repo: "grovie",
    number,
  };
}

function fakeComment(overrides: Partial<GitHubIssue["comments"][number]> = {}): GitHubIssue["comments"][number] {
  return {
    id: 1,
    body: "",
    author: "fankaidev",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fakeRelatedPullRequest(overrides: Partial<GitHubRelatedPullRequest> = {}): GitHubRelatedPullRequest {
  return {
    number: 20,
    title: "Implement daemon",
    state: "open",
    url: "https://github.com/fankaidev/grovie/pull/20",
    body: "Closes #8",
    baseRef: "main",
    headRef: "grovie/issue-8",
    headSha: "abc123",
    updatedAt: NOW.toISOString(),
    comments: [],
    reviewComments: [],
    reviews: [],
    checks: {
      totalCount: 0,
      conclusionCounts: {},
    },
    ...overrides,
  };
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (address === null || typeof address === "string") {
    throw new Error("Could not resolve test server port.");
  }

  return address.port;
}

async function expectPortCanBind(port: number): Promise<void> {
  const server = createServer();
  let listening = false;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        listening = true;
        resolve();
      });
    });
  } finally {
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function createTmpDir(): string {
  const dir = join(tmpdir(), `grovie-daemon-${Math.random().toString(16).slice(2)}`);
  tmpDirs.push(dir);
  return dir;
}

function configuredCodexAgent(name: string, machineId: string) {
  return {
    agentId: `${name}@${machineId}`,
    name,
    machineId,
    runtime: "codex" as const,
    args: [],
    envKeys: ["OPENAI_API_KEY"],
  };
}

function writeRunMetadata(
  localState: LocalState,
  runId: string,
  metadata: Record<string, unknown>,
  events: Array<Record<string, unknown>> = [],
): void {
  const runDir = join(localState.getPaths().runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), events.map((item) => JSON.stringify(item)).join("\n"), "utf8");
  writeFileSync(join(runDir, "stdout.log"), "", "utf8");
  writeFileSync(join(runDir, "stderr.log"), "", "utf8");
  writeFileSync(join(runDir, "prompt.md"), "", "utf8");
  writeFileSync(join(runDir, "task.json"), "{}\n", "utf8");
}

function readRunMetadata(localState: LocalState, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localState.getPaths().runsDir, runId, "metadata.json"), "utf8")) as Record<string, unknown>;
}
