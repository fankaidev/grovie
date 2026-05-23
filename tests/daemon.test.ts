import { describe, expect, it } from "vitest";
import type { GrovieConfig } from "../src/config.js";
import { runDaemonCycle, runDaemonForRepositories } from "../src/daemon.js";
import type {
  CreatedComment,
  GitHubGateway,
  GitHubIssue,
  GitHubIssueSummary,
  IssueReference,
} from "../src/github.js";
import type { RunIssueAsyncInput, RunIssueResult } from "../src/run.js";

const NOW = new Date("2026-05-22T00:00:00Z");

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
    expect(github.createdComments[0]).toContain("Grovie daemon claimed.");
    expect(github.updatedComments.map((comment) => comment.body)).toEqual([
      expect.stringContaining("Grovie daemon running."),
      expect.stringContaining("Grovie daemon completed."),
    ]);
  });

  it("skips issues with a visible active claim", async () => {
    const github = new FakeGitHub([
      fakeIssue({
        comments: [
          fakeComment({
            id: 99,
            body: '<!-- grovie:claim {"workerId":"other","status":"running"} -->\nGrovie daemon running.',
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
    expect(runs).toHaveLength(0);
    expect(github.createdComments).toHaveLength(0);
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
    expect(github.updatedComments.at(-1)?.body).toContain("Grovie daemon canceled.");
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
      expect.stringContaining("Grovie daemon running."),
      expect.stringContaining("Grovie daemon running."),
      expect.stringContaining("Grovie daemon canceled."),
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
      expect.stringContaining("Grovie daemon running."),
      expect.stringContaining("Grovie daemon failed."),
    ]);
    expect(github.updatedComments.at(-1)?.body).toContain(
      "- Note: Run failed. See the Grovie result comment and local run logs.",
    );
  });

  it("reclaims a stale visible claim conservatively", async () => {
    const github = new FakeGitHub([
      fakeIssue({
        comments: [
          fakeComment({
            id: 99,
            body: '<!-- grovie:claim {"workerId":"other","status":"running"} -->\nGrovie daemon running.',
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
      staleClaimMs: 1_000,
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
    expect(github.createdComments[0]).toContain("Grovie daemon claimed.");
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

      if (this.options.addCancelOnRunningUpdate === true && body.includes("Grovie daemon running.")) {
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
