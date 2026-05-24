import type { RuntimeName } from "./runtime.js";

export type RuntimeTranscriptEntry =
  | { kind: "status"; label: string; detail?: string }
  | { kind: "turn"; label: string; detail?: string }
  | { kind: "assistant_message"; text: string }
  | { kind: "command_execution"; command: string; status?: string; exitCode?: number }
  | { kind: "command_output"; text: string }
  | { kind: "tool_call"; label: string; status?: string; detail?: string }
  | { kind: "exit_code"; exitCode: number; detail?: string };

export type RuntimeTranscript = {
  runtime: string;
  recognized: boolean;
  message?: string;
  entries: RuntimeTranscriptEntry[];
};

export type RuntimeTranscriptParser = {
  runtime: RuntimeName;
  parse(stdout: string): RuntimeTranscript;
};

type CodexJsonEvent = {
  type?: unknown;
  thread_id?: unknown;
  item?: unknown;
  usage?: unknown;
};

type CodexItem = {
  type?: unknown;
  text?: unknown;
  command?: unknown;
  aggregated_output?: unknown;
  exit_code?: unknown;
  status?: unknown;
  server?: unknown;
  tool?: unknown;
  error?: unknown;
};

const CODEX_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
]);

export function parseRuntimeStdoutTranscript(runtime: string | undefined, stdout: string): RuntimeTranscript {
  const parser = getRuntimeTranscriptParser(runtime);

  if (parser === undefined) {
    return {
      runtime: runtime ?? "unknown",
      recognized: false,
      message: runtime === undefined
        ? "Run runtime is unknown, so stdout cannot be rendered as a transcript."
        : `Readable transcript is not available for runtime ${runtime}.`,
      entries: [],
    };
  }

  return parser.parse(stdout);
}

export function getRuntimeTranscriptParser(runtime: string | undefined): RuntimeTranscriptParser | undefined {
  if (runtime === "codex") {
    return codexTranscriptParser;
  }

  return undefined;
}

const codexTranscriptParser: RuntimeTranscriptParser = {
  runtime: "codex",
  parse: parseCodexStdoutTranscript,
};

function parseCodexStdoutTranscript(stdout: string): RuntimeTranscript {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return {
      runtime: "codex",
      recognized: false,
      message: "stdout is empty; no Codex transcript events were found.",
      entries: [],
    };
  }

  const events: CodexJsonEvent[] = [];

  for (const line of lines) {
    const parsed = parseJsonObject(line);

    if (parsed === undefined || !isKnownCodexEvent(parsed)) {
      return {
        runtime: "codex",
        recognized: false,
        message: "stdout is not recognized as Codex JSONL. Use Raw stdout to inspect the original output.",
        entries: [],
      };
    }

    events.push(parsed);
  }

  const entries = events.flatMap(renderCodexEvent);

  return {
    runtime: "codex",
    recognized: true,
    entries,
  };
}

function renderCodexEvent(event: CodexJsonEvent): RuntimeTranscriptEntry[] {
  if (event.type === "thread.started") {
    return [{
      kind: "status",
      label: "Session started",
      detail: typeof event.thread_id === "string" ? event.thread_id : undefined,
    }];
  }

  if (event.type === "turn.started") {
    return [{ kind: "turn", label: "Turn started" }];
  }

  if (event.type === "turn.completed") {
    return [{ kind: "turn", label: "Turn completed", detail: renderUsage(event.usage) }];
  }

  if (event.type === "item.started" || event.type === "item.completed") {
    return renderCodexItem(event.item, event.type);
  }

  return [{
    kind: "status",
    label: String(event.type),
  }];
}

function renderCodexItem(value: unknown, eventType: "item.started" | "item.completed"): RuntimeTranscriptEntry[] {
  if (!isObject(value)) {
    return [];
  }

  const item = value as CodexItem;

  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{ kind: "assistant_message", text: item.text }];
  }

  if (item.type === "command_execution" && typeof item.command === "string") {
    const status = typeof item.status === "string" ? item.status : eventType === "item.started" ? "in_progress" : undefined;
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    const entries: RuntimeTranscriptEntry[] = [{
      kind: "command_execution",
      command: item.command,
      status,
      exitCode,
    }];

    if (typeof item.aggregated_output === "string" && item.aggregated_output.length > 0) {
      entries.push({
        kind: "command_output",
        text: item.aggregated_output,
      });
    }

    if (exitCode !== undefined) {
      entries.push({
        kind: "exit_code",
        exitCode,
        detail: status,
      });
    }

    return entries;
  }

  if (item.type === "mcp_tool_call") {
    return [{
      kind: "tool_call",
      label: [
        typeof item.server === "string" ? item.server : undefined,
        typeof item.tool === "string" ? item.tool : undefined,
      ].filter((part) => part !== undefined).join(".") || "Tool call",
      status: typeof item.status === "string" ? item.status : undefined,
      detail: readToolError(item.error),
    }];
  }

  if (typeof item.type === "string") {
    return [{
      kind: "status",
      label: item.type,
      detail: typeof item.status === "string" ? item.status : undefined,
    }];
  }

  return [];
}

function isKnownCodexEvent(value: CodexJsonEvent): boolean {
  return typeof value.type === "string" && CODEX_EVENT_TYPES.has(value.type);
}

function parseJsonObject(line: string): CodexJsonEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isObject(value) ? value as CodexJsonEvent : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function renderUsage(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : undefined;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return `input ${inputTokens ?? 0}, output ${outputTokens ?? 0} tokens`;
}

function readToolError(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  return typeof value.message === "string" ? value.message : undefined;
}
