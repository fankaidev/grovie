import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubGateway, GitHubRepositoryEvent } from "../src/github.js";
import { resolvePaths } from "../src/local-state.js";
import { planRepositoryEventPolling } from "../src/repository-events.js";

const NOW = new Date("2026-05-24T12:00:00Z");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("repository event polling", () => {
  it("[UC-WORKER-04-S15] initializes repository event polling with a full scan", () => {
    const paths = resolvePaths({ root: createTmpDir() });

    expect(planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-2"), event("event-1")],
      github: fakeGithub(),
      now: NOW,
    })).toEqual({
      mode: "full-scan",
      reason: "repository event cursor is not initialized",
      eventCount: 2,
    });
  });

  it("[UC-WORKER-04-S15] initializes empty repository event polling with a full scan", () => {
    const paths = resolvePaths({ root: createTmpDir() });

    expect(planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [],
      github: fakeGithub(),
      now: NOW,
    })).toEqual({
      mode: "full-scan",
      reason: "repository event cursor is not initialized",
      eventCount: 0,
    });
  });

  it("[UC-WORKER-04-S15] skips queue inspection when repository events have not changed", () => {
    const paths = resolvePaths({ root: createTmpDir() });
    planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-2"), event("event-1")],
      github: fakeGithub(),
      now: NOW,
    });

    expect(planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-2"), event("event-1")],
      github: fakeGithub(),
      now: new Date("2026-05-24T12:01:00Z"),
    })).toEqual({
      mode: "skip",
      reason: "no new repository events",
      eventCount: 0,
    });
  });

  it("[UC-WORKER-04-S15] filters queue inspection to issues affected by new issue events", () => {
    const paths = resolvePaths({ root: createTmpDir() });
    planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-1")],
      github: fakeGithub(),
      now: NOW,
    });

    expect(planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [
        event("event-3", {
          type: "IssueCommentEvent",
          issueNumber: 124,
          issueUrl: "https://github.com/fankaidev/grovie/issues/124",
        }),
        event("event-1"),
      ],
      github: fakeGithub(),
      now: new Date("2026-05-24T12:01:00Z"),
    })).toEqual({
      mode: "filtered",
      issueNumbers: [124],
      reason: "new repository events affect tracked issues",
      eventCount: 1,
    });
  });

  it("[UC-WORKER-04-S15] resolves pull request events through GitHub and caches PR issue links", () => {
    const paths = resolvePaths({ root: createTmpDir() });
    const links: Array<{ pullRequestNumber: number; issueNumber: number; source: "closing-reference" | "body" | "branch" }> = [
      { pullRequestNumber: 127, issueNumber: 124, source: "closing-reference" },
    ];
    const github = fakeGithub(links);
    planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-1")],
      github,
      now: NOW,
    });

    const first = planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [
        event("event-2", {
          type: "IssueCommentEvent",
          issueNumber: 127,
          issueUrl: "https://github.com/fankaidev/grovie/pull/127",
          commentUrl: "https://github.com/fankaidev/grovie/pull/127#issuecomment-1",
        }),
        event("event-1"),
      ],
      github,
      now: new Date("2026-05-24T12:01:00Z"),
    });

    expect(first).toMatchObject({
      mode: "filtered",
      issueNumbers: [124],
    });
    expect(github.calls).toEqual([127]);
    links.splice(0, links.length, { pullRequestNumber: 127, issueNumber: 125, source: "closing-reference" });

    const second = planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [
        event("event-3", {
          type: "PullRequestReviewEvent",
          pullRequestNumber: 127,
          reviewUrl: "https://github.com/fankaidev/grovie/pull/127#pullrequestreview-1",
        }),
        event("event-2"),
      ],
      github,
      now: new Date("2026-05-24T12:02:00Z"),
    });

    expect(second).toMatchObject({
      mode: "filtered",
      issueNumbers: [125],
    });
    expect(github.calls).toEqual([127, 127]);
  });

  it("[UC-WORKER-04-S15] falls back to a full scan when the events cursor is outside the returned window", () => {
    const paths = resolvePaths({ root: createTmpDir() });
    planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-1")],
      github: fakeGithub(),
      now: NOW,
    });

    expect(planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-3"), event("event-2")],
      github: fakeGithub(),
      now: new Date("2026-05-24T12:01:00Z"),
    })).toMatchObject({
      mode: "full-scan",
      reason: "repository event cursor fell outside the events window",
    });
  });

  it("[UC-WORKER-04-S15] periodically falls back to a full scan even when events do not change", () => {
    const paths = resolvePaths({ root: createTmpDir() });
    planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-1")],
      github: fakeGithub(),
      now: NOW,
    });

    expect(planRepositoryEventPolling({
      paths,
      repository: "fankaidev/grovie",
      events: [event("event-1")],
      github: fakeGithub(),
      now: new Date("2026-05-24T12:06:00Z"),
    })).toMatchObject({
      mode: "full-scan",
      reason: "periodic full scan fallback is due",
    });
  });
});

function event(id: string, overrides: Partial<GitHubRepositoryEvent> = {}): GitHubRepositoryEvent {
  return {
    id,
    type: "PushEvent",
    createdAt: NOW.toISOString(),
    actor: "fankaidev",
    ...overrides,
  };
}

function fakeGithub(
  links: Array<{ pullRequestNumber: number; issueNumber: number; source: "closing-reference" | "body" | "branch" }> = [],
) {
  const calls: number[] = [];
  return {
    calls,
    readPullRequestIssueLinks: (_repository: string, pullRequestNumber: number) => {
      calls.push(pullRequestNumber);
      return {
        ok: true as const,
        value: links.filter((link) => link.pullRequestNumber === pullRequestNumber),
      };
    },
  } satisfies Pick<GitHubGateway, "readPullRequestIssueLinks"> & { calls: number[] };
}

function createTmpDir(): string {
  const dir = join(tmpdir(), `grovie-repository-events-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".keep"), "", "utf8");
  tmpDirs.push(dir);
  return dir;
}
