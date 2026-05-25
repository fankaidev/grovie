import { appendDaemonActivity } from "../daemon-activity.js";
import type { DaemonInput } from "./types.js";

export function recordActivity(
  input: Pick<DaemonInput, "localState" | "now">,
  entry: Parameters<typeof appendDaemonActivity>[1],
): void {
  appendDaemonActivity(input.localState?.getPaths?.(), {
    ...entry,
    timestamp: entry.timestamp ?? (input.now?.() ?? new Date()).toISOString(),
  });
}
