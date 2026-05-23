import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonLogStream = "combined" | "stdout" | "stderr";

export type DaemonLogReadInput = {
  root: string;
  stream?: DaemonLogStream;
  lines?: number;
};

export type DaemonLogFollowInput = DaemonLogReadInput;

export type DaemonLogPaths = {
  daemonDir: string;
  stdoutPath: string;
  stderrPath: string;
};

const DEFAULT_LINE_COUNT = 100;

export function readDaemonLogs(
  input: DaemonLogReadInput,
): { ok: true; output: string } | { ok: false; message: string } {
  const paths = getDaemonLogPaths(input.root);
  const stream = input.stream ?? "combined";
  const lineCount = normalizeLineCount(input.lines);
  const selectedPaths = selectLogPaths(paths, stream);
  const validation = validateLogPaths(paths, selectedPaths);

  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    output: renderDaemonLogs({
      paths,
      stream,
      entries: selectedPaths.map((path) => ({
        path,
        content: readLastLines(path, lineCount),
      })),
    }),
  };
}

export function followDaemonLogs(
  input: DaemonLogFollowInput,
): { ok: true; exitCode: number } | { ok: false; message: string } {
  const paths = getDaemonLogPaths(input.root);
  const selectedPaths = selectLogPaths(paths, input.stream ?? "combined");
  const validation = validateLogPaths(paths, selectedPaths);

  if (!validation.ok) {
    return validation;
  }

  const result = spawnSync("tail", buildTailDaemonLogsArgs({
    root: input.root,
    stream: input.stream,
    lines: input.lines,
  }), {
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    return {
      ok: false,
      message: result.error.message,
    };
  }

  return {
    ok: true,
    exitCode: result.status ?? 0,
  };
}

export function buildTailDaemonLogsArgs(input: DaemonLogFollowInput): string[] {
  return [
    "-n",
    String(normalizeLineCount(input.lines)),
    "-f",
    ...selectLogPaths(getDaemonLogPaths(input.root), input.stream ?? "combined"),
  ];
}

export function parseDaemonLogStream(value: string | undefined): DaemonLogStream | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "combined" || value === "stdout" || value === "stderr") {
    return value;
  }

  throw new Error("Invalid daemon log stream. Expected one of: combined, stdout, stderr.");
}

function getDaemonLogPaths(root: string): DaemonLogPaths {
  const daemonDir = join(root, "daemon");

  return {
    daemonDir,
    stdoutPath: join(daemonDir, "stdout.log"),
    stderrPath: join(daemonDir, "stderr.log"),
  };
}

function validateLogPaths(
  paths: DaemonLogPaths,
  selectedPaths: string[],
): { ok: true } | { ok: false; message: string } {
  if (!existsSync(paths.daemonDir)) {
    return {
      ok: false,
      message: `Daemon logs are not available because ${paths.daemonDir} does not exist. Run \`grovie daemon start\` first.`,
    };
  }

  for (const path of selectedPaths) {
    if (!existsSync(path)) {
      return {
        ok: false,
        message: `Daemon log file does not exist: ${path}`,
      };
    }
  }

  return {
    ok: true,
  };
}

function selectLogPaths(paths: DaemonLogPaths, stream: DaemonLogStream): string[] {
  if (stream === "stdout") {
    return [paths.stdoutPath];
  }

  if (stream === "stderr") {
    return [paths.stderrPath];
  }

  return [paths.stdoutPath, paths.stderrPath];
}

function renderDaemonLogs(input: {
  paths: DaemonLogPaths;
  stream: DaemonLogStream;
  entries: Array<{ path: string; content: string }>;
}): string {
  const sections = input.entries.map((entry) => [
    `== ${entry.path === input.paths.stdoutPath ? "stdout" : "stderr"} (${entry.path}) ==`,
    entry.content.length === 0 ? "(no output)" : entry.content,
  ].join("\n"));

  return [
    "grovie daemon logs",
    "",
    `Stream: ${input.stream}`,
    ...sections,
  ].join("\n");
}

function readLastLines(path: string, lineCount: number): string {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const normalizedLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;

  return normalizedLines.slice(-lineCount).join("\n");
}

function normalizeLineCount(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LINE_COUNT;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Invalid daemon log line count. Expected a positive integer.");
  }

  return value;
}
