import { describe, expect, it } from "vitest";
import { parseRuntimeStdoutTranscript } from "../src/runtime-transcript.js";

describe("runtime stdout transcript parser", () => {
  it("[UC-ADMIN-04-S06] parses Codex JSONL stdout into readable transcript entries", () => {
    const transcript = parseRuntimeStdoutTranscript("codex", [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I will inspect the run." } }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pnpm check", status: "in_progress" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pnpm check", aggregated_output: "ok\n", exit_code: 0, status: "completed" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n"));

    expect(transcript).toMatchObject({
      runtime: "codex",
      recognized: true,
      entries: [
        { kind: "status", label: "Session started", detail: "codex-thread-1" },
        { kind: "turn", label: "Turn started" },
        { kind: "assistant_message", text: "I will inspect the run." },
        { kind: "command_execution", command: "pnpm check", status: "in_progress" },
        { kind: "command_execution", command: "pnpm check", status: "completed", exitCode: 0 },
        { kind: "command_output", text: "ok\n" },
        { kind: "exit_code", exitCode: 0, detail: "completed" },
        { kind: "turn", label: "Turn completed", detail: "input 10, output 5 tokens" },
      ],
    });
  });

  it("[UC-ADMIN-04-S07] degrades clearly when stdout is not Codex JSONL", () => {
    expect(parseRuntimeStdoutTranscript("codex", "plain stdout\n")).toEqual({
      runtime: "codex",
      recognized: false,
      message: "stdout is not recognized as Codex JSONL. Use Raw stdout to inspect the original output.",
      entries: [],
    });
  });
});
