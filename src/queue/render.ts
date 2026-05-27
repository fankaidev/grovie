import { formatIssueReference } from "../github.js";
import type { QueueInspectionResult } from "../queue.js";

export function renderSkippedQueueSummary(results: QueueInspectionResult[]): string | undefined {
  const skipped = results.flatMap((result) =>
    result.candidates
      .filter((candidate) => candidate.status === "skipped")
      .map((candidate) => ({
        repository: result.repository,
        candidate,
      })),
  );

  if (skipped.length === 0) {
    return undefined;
  }

  return [
    "Skipped assigned issues:",
    ...skipped.map(({ candidate }) =>
      `- ${formatIssueReference(candidate.issueReference)} agent=${candidate.agentId ?? "(none)"} reason=${candidate.reason ?? "skipped"}`,
    ),
  ].join("\n");
}
