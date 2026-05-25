import { formatIssueReference } from "../github.js";
import type { QueueInspectionResult } from "../queue.js";

export function renderQueueInspection(results: QueueInspectionResult[], title = "grovie queue list"): string {
  const lines = [title, ""];

  if (results.every((result) => result.candidates.length === 0)) {
    lines.push("No assigned issues found.");
    return lines.join("\n");
  }

  for (const result of results) {
    lines.push(`${result.repository} label=${result.label}`);

    if (result.candidates.length === 0) {
      lines.push("- No assigned issues.");
      continue;
    }

    for (const candidate of result.candidates) {
      const prefix = candidate.status === "runnable" ? `#${candidate.pickOrder ?? "?"}` : "skip";
      const reason = candidate.status === "skipped" ? ` reason=${candidate.reason}` : "";
      lines.push(`- ${prefix} ${formatIssueReference(candidate.issueReference)} agent=${candidate.agentId ?? "(none)"} priority=${candidate.priority} activity=${candidate.activity.timestamp}${reason}`);
      lines.push(`  ${candidate.title}`);
    }
  }

  return lines.join("\n");
}

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
