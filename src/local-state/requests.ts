import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, readdirRequestFiles, removeFileIfExists, writeJsonFile } from "./files.js";
import { buildRunTimestamp, sanitizePathPart } from "./ids.js";
import type { LocalStatePaths, RunRequest } from "./types.js";

export function enqueueRunRequest(
  paths: LocalStatePaths,
  input: {
    repository: string;
    issueNumber: number;
    agentId: string;
    now?: Date;
    sourceRunId?: string;
    reason?: RunRequest["reason"];
  },
): RunRequest {
  const createdAt = (input.now ?? new Date()).toISOString();
  const id = [
    buildRunTimestamp(new Date(createdAt)),
    sanitizePathPart(input.repository),
    `issue-${input.issueNumber}`,
    sanitizePathPart(input.agentId),
  ].join("-");
  const requestPath = getRunRequestPath(paths, id);
  const request = {
    id: requestPath.id,
    repository: input.repository,
    issueNumber: input.issueNumber,
    agentId: input.agentId,
    createdAt,
    path: requestPath.path,
    sourceRunId: input.sourceRunId,
    reason: input.reason,
  };

  writeJsonFile(requestPath.path, request);
  return request;
}

export function takeRunRequest(paths: LocalStatePaths, repository: string): RunRequest | undefined {
  const entries = readdirRequestFiles(paths.requestsDir);

  for (const entry of entries) {
    const request = readJsonFile<RunRequest>(join(paths.requestsDir, entry));

    if (request?.repository !== repository) {
      continue;
    }

    const path = join(paths.requestsDir, entry);
    removeFileIfExists(path);
    return {
      ...request,
      path,
    };
  }

  return undefined;
}

function getRunRequestPath(paths: LocalStatePaths, id: string): { id: string; path: string } {
  let candidate = id;
  let path = join(paths.requestsDir, `${candidate}.json`);
  let suffix = 2;

  while (existsSync(path)) {
    candidate = `${id}-${suffix}`;
    path = join(paths.requestsDir, `${candidate}.json`);
    suffix += 1;
  }

  return {
    id: candidate,
    path,
  };
}
