import { rmSync } from "node:fs";
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
  IssueReference,
} from "../src/github.js";
import { resolveMachineId } from "../src/identity.js";
import { LocalState } from "../src/local-state.js";
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

  it("[UC-WORKER-01-S04] uses the default local agent id as the daemon worker id", async () => {
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

  it("[UC-WORKER-03-S05] skips issues assigned only to another machine", async () => {
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

  it("[UC-EXECUTION-01-S01] consumes one manual run request before scheduled issues", async () => {
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
    expect(github.createdComments[0]).toContain("- Worker: `coder@fankai-mac`");
    expect(localState.takeRunRequest("fankaidev/grovie")).toBeUndefined();
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

  it("[UC-WORKER-04-S05] skips an issue when a local execution lock already exists", async () => {
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

  it("[UC-EXECUTION-02-S04] skips unchanged issue activity covered by the handled cursor", async () => {
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

function createTmpDir(): string {
  const dir = join(tmpdir(), `grovie-daemon-${Math.random().toString(16).slice(2)}`);
  tmpDirs.push(dir);
  return dir;
}
