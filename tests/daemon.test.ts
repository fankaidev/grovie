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
    })?.handledThrough).toBe(NOW.toISOString());
  });

  it("[UC-EXECUTION-02-S04] includes Grovie result comments in the terminal handled cursor", async () => {
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
    })?.handledThrough).toBe(NOW.toISOString());
    expect(secondResult.processed).toBe(false);
  });

  it("[UC-GITHUB-01-S05] ignores visible claim comments when choosing local execution", async () => {
    const github = new FakeGitHub([
      fakeIssue({
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
    expect(github.createdComments[0]).toContain(`- Worker: \`default@${resolveMachineId(hostname())}\``);
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
    const github = new FakeGitHub([
      fakeIssue({
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

  it("checks multiple watched repositories sequentially until it finds queued work", async () => {
    const github = new FakeGitHub([
      fakeIssue({
        reference: {
          owner: "fankaidev",
          repo: "other",
          number: 5,
        },
        labels: ["ready"],
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
    private readonly options: { addCancelAfterClaim?: boolean; addCancelOnRunningUpdate?: boolean } = {},
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
    issue.comments.push(
      fakeComment({
        id,
        body,
      }),
    );

    if (this.options.addCancelAfterClaim) {
      issue.comments.push(
        fakeComment({
          id: this.nextCommentId++,
          body: "/grovie cancel",
        }),
      );
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

    for (const issue of this.issues) {
      const comment = issue.comments.find((candidate) => candidate.id === commentId);

      if (comment !== undefined) {
        comment.body = body;
        comment.updatedAt = NOW.toISOString();
      }

      if (this.options.addCancelOnRunningUpdate === true && body.includes("Grovie daemon task claim active.")) {
        issue.comments.push(
          fakeComment({
            id: this.nextCommentId++,
            body: "/grovie cancel",
          }),
        );
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
    labels: ["grovie"],
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
