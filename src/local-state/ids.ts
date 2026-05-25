export function buildSessionId(repository: string, issueNumber: number, agentId: string): string {
  return `${sanitizeRepository(repository)}-issue-${issueNumber}-${sanitizePathPart(agentId)}`;
}

export function buildRunId(sessionId: string, runTimestamp = buildRunTimestamp()): string {
  return `${sanitizePathPart(sessionId)}-${sanitizePathPart(runTimestamp)}`;
}

export function buildBranchName(branchPrefix: string, sessionId: string): string {
  const normalizedPrefix = branchPrefix.endsWith("/") ? branchPrefix : `${branchPrefix}/`;
  return `${normalizedPrefix}${sanitizePathPart(sessionId)}`;
}

export function buildLocalBranchName(branchPrefix: string, sessionId: string): string {
  return buildBranchName(branchPrefix, sessionId);
}

export function buildRunTimestamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

export function sanitizeRepository(repository: string): string {
  return repository.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}
