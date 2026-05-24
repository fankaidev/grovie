import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitHubGateway, GitHubRepositoryEvent, GitHubPullRequestIssueLink } from "./github.js";
import type { LocalStatePaths } from "./local-state.js";
import { listLocalRuns } from "./status.js";

export type RepositoryEventPlan = {
  mode: "full-scan" | "skip" | "filtered";
  issueNumbers?: number[];
  reason: string;
  eventCount: number;
};

type RepositoryEventCursor = {
  repository: string;
  lastSeenEventId?: string;
  lastFullScanAt?: string;
  updatedAt: string;
};

type PullRequestIssueAssociation = {
  repository: string;
  pullRequestNumber: number;
  issueNumbers: number[];
  updatedAt: string;
  source: "local-run" | GitHubPullRequestIssueLink["source"];
};

const FULL_SCAN_FALLBACK_INTERVAL_MS = 5 * 60 * 1000;

export function planRepositoryEventPolling(input: {
  paths: LocalStatePaths | undefined;
  repository: string;
  events: GitHubRepositoryEvent[];
  github: Pick<GitHubGateway, "readPullRequestIssueLinks">;
  now?: Date;
}): RepositoryEventPlan {
  if (input.paths === undefined) {
    return {
      mode: "full-scan",
      reason: "local state is unavailable",
      eventCount: input.events.length,
    };
  }

  const cursor = readRepositoryEventCursor(input.paths, input.repository);
  const newestEventId = input.events[0]?.id;

  if (newestEventId === undefined) {
    if (cursor === undefined || isFullScanDue(cursor.lastFullScanAt, input.now)) {
      markRepositoryFullScan(input.paths, input.repository, undefined, input.now);
      return {
        mode: "full-scan",
        reason: cursor === undefined
          ? "repository event cursor is not initialized"
          : "periodic full scan fallback is due",
        eventCount: 0,
      };
    }

    return {
      mode: "skip",
      reason: "repository events are empty",
      eventCount: 0,
    };
  }

  refreshPullRequestIssueAssociationsFromRuns(input.paths, input.repository, input.now);
  writeRepositoryEventCursor(input.paths, {
    repository: input.repository,
    lastSeenEventId: newestEventId,
    lastFullScanAt: cursor?.lastFullScanAt,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });

  if (cursor?.lastSeenEventId === undefined) {
    markRepositoryFullScan(input.paths, input.repository, newestEventId, input.now);
    return {
      mode: "full-scan",
      reason: "repository event cursor is not initialized",
      eventCount: input.events.length,
    };
  }

  const cursorIndex = input.events.findIndex((event) => event.id === cursor.lastSeenEventId);

  if (cursorIndex < 0) {
    markRepositoryFullScan(input.paths, input.repository, newestEventId, input.now);
    return {
      mode: "full-scan",
      reason: "repository event cursor fell outside the events window",
      eventCount: input.events.length,
    };
  }

  const newEvents = input.events.slice(0, cursorIndex);

  if (newEvents.length === 0) {
    if (isFullScanDue(cursor.lastFullScanAt, input.now)) {
      markRepositoryFullScan(input.paths, input.repository, newestEventId, input.now);
      return {
        mode: "full-scan",
        reason: "periodic full scan fallback is due",
        eventCount: 0,
      };
    }

    return {
      mode: "skip",
      reason: "no new repository events",
      eventCount: 0,
    };
  }

  const issueNumbers = new Set<number>();
  let hasUnresolvedPullRequestEvent = false;

  for (const event of newEvents) {
    const eventIssueNumbers = issueNumbersFromEvent(input.paths, input.repository, event, input.github);

    if (eventIssueNumbers === undefined) {
      hasUnresolvedPullRequestEvent = true;
      continue;
    }

    for (const issueNumber of eventIssueNumbers) {
      issueNumbers.add(issueNumber);
    }
  }

  if (hasUnresolvedPullRequestEvent) {
    markRepositoryFullScan(input.paths, input.repository, newestEventId, input.now);
    return {
      mode: "full-scan",
      reason: "new pull request event could not be resolved to issues",
      eventCount: newEvents.length,
    };
  }

  if (issueNumbers.size === 0) {
    return {
      mode: "skip",
      reason: "new repository events do not affect tracked issues",
      eventCount: newEvents.length,
    };
  }

  return {
    mode: "filtered",
    issueNumbers: [...issueNumbers].sort((left, right) => left - right),
    reason: "new repository events affect tracked issues",
    eventCount: newEvents.length,
  };
}

function issueNumbersFromEvent(
  paths: LocalStatePaths,
  repository: string,
  event: GitHubRepositoryEvent,
  github: Pick<GitHubGateway, "readPullRequestIssueLinks">,
): number[] | undefined {
  if (event.issueNumber !== undefined && !isPullRequestUrl(event.issueUrl)) {
    return [event.issueNumber];
  }

  const pullRequestNumber = pullRequestNumberFromEvent(event);

  if (pullRequestNumber === undefined) {
    return [];
  }

  const linksResult = github.readPullRequestIssueLinks?.(repository, pullRequestNumber);

  if (linksResult === undefined || !linksResult.ok) {
    return undefined;
  }

  cachePullRequestIssueLinks(paths, repository, linksResult.value);
  return linksResult.value.map((link) => link.issueNumber);
}

function pullRequestNumberFromEvent(event: GitHubRepositoryEvent): number | undefined {
  if (event.pullRequestNumber !== undefined) {
    return event.pullRequestNumber;
  }

  return parsePullRequestNumber(event.issueUrl)
    ?? parsePullRequestNumber(event.commentUrl)
    ?? parsePullRequestNumber(event.reviewUrl)
    ?? parsePullRequestNumber(event.pullRequestUrl);
}

function isPullRequestUrl(value: string | undefined): boolean {
  return value !== undefined && /\/pull\/\d+(?:$|[#?])/.test(value);
}

function parsePullRequestNumber(value: string | undefined): number | undefined {
  const match = /\/pull\/(?<number>[1-9]\d*)(?:$|[#?])/.exec(value ?? "");
  return match?.groups?.number === undefined ? undefined : Number.parseInt(match.groups.number, 10);
}

function refreshPullRequestIssueAssociationsFromRuns(paths: LocalStatePaths, repository: string, now?: Date): void {
  const associations = readPullRequestIssueAssociations(paths);
  const updatedAt = (now ?? new Date()).toISOString();

  for (const run of listLocalRuns(paths.runsDir)) {
    if (run.repository !== repository || run.issueNumber === undefined) {
      continue;
    }

    for (const link of run.resultLinks) {
      const pullRequestNumber = parsePullRequestNumber(link);

      if (pullRequestNumber === undefined) {
        continue;
      }

      associations[pullRequestAssociationKey(repository, pullRequestNumber)] = {
        repository,
        pullRequestNumber,
        issueNumbers: [run.issueNumber],
        updatedAt,
        source: "local-run",
      };
    }
  }

  writePullRequestIssueAssociations(paths, associations);
}

function cachePullRequestIssueLinks(paths: LocalStatePaths, repository: string, links: GitHubPullRequestIssueLink[], now = new Date()): void {
  if (links.length === 0) {
    return;
  }

  const associations = readPullRequestIssueAssociations(paths);
  const updatedAt = now.toISOString();

  const linksByPullRequest = new Map<number, GitHubPullRequestIssueLink[]>();

  for (const link of links) {
    linksByPullRequest.set(link.pullRequestNumber, [...(linksByPullRequest.get(link.pullRequestNumber) ?? []), link]);
  }

  for (const [pullRequestNumber, pullRequestLinks] of linksByPullRequest) {
    associations[pullRequestAssociationKey(repository, pullRequestNumber)] = {
      repository,
      pullRequestNumber,
      issueNumbers: [...new Set(pullRequestLinks.map((link) => link.issueNumber))].sort((left, right) => left - right),
      updatedAt,
      source: pullRequestLinks[0]?.source ?? "body",
    };
  }

  writePullRequestIssueAssociations(paths, associations);
}

function isFullScanDue(lastFullScanAt: string | undefined, now?: Date): boolean {
  if (lastFullScanAt === undefined || Number.isNaN(Date.parse(lastFullScanAt))) {
    return true;
  }

  return (now ?? new Date()).getTime() - Date.parse(lastFullScanAt) >= FULL_SCAN_FALLBACK_INTERVAL_MS;
}

function markRepositoryFullScan(paths: LocalStatePaths, repository: string, lastSeenEventId: string | undefined, now?: Date): void {
  writeRepositoryEventCursor(paths, {
    repository,
    lastSeenEventId,
    lastFullScanAt: (now ?? new Date()).toISOString(),
    updatedAt: (now ?? new Date()).toISOString(),
  });
}

function readRepositoryEventCursor(paths: LocalStatePaths, repository: string): RepositoryEventCursor | undefined {
  return readJsonFile<RepositoryEventCursor>(repositoryEventCursorPath(paths, repository));
}

function writeRepositoryEventCursor(paths: LocalStatePaths, cursor: RepositoryEventCursor): void {
  writeJsonFile(repositoryEventCursorPath(paths, cursor.repository), cursor);
}

function repositoryEventCursorPath(paths: LocalStatePaths, repository: string): string {
  return join(paths.root, "daemon", "events", `${sanitizePathPart(repository)}.json`);
}

function readPullRequestIssueAssociations(paths: LocalStatePaths): Record<string, PullRequestIssueAssociation> {
  return readJsonFile<Record<string, PullRequestIssueAssociation>>(pullRequestAssociationsPath(paths)) ?? {};
}

function writePullRequestIssueAssociations(paths: LocalStatePaths, associations: Record<string, PullRequestIssueAssociation>): void {
  writeJsonFile(pullRequestAssociationsPath(paths), associations);
}

function pullRequestAssociationsPath(paths: LocalStatePaths): string {
  return join(paths.root, "daemon", "pr-issue-associations.json");
}

function pullRequestAssociationKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  return JSON.parse(readFileSync(path, "utf8")) as T;
}
