import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTailDaemonLogsArgs, readDaemonLogs } from "../src/daemon-logs.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("daemon logs", () => {
  it("[UC-DAEMON-04-S05] reads recent daemon stdout and stderr from the daemon directory", () => {
    const root = createTmpDir();
    writeDaemonLogs(root, {
      stdout: "stdout-1\nstdout-2\nstdout-3\n",
      stderr: "stderr-1\nstderr-2\n",
    });

    const result = readDaemonLogs({
      root,
      lines: 2,
    });

    expect(result).toEqual({
      ok: true,
      output: [
        "grovie daemon logs",
        "",
        "Stream: combined",
        `== stdout (${root}/daemon/stdout.log) ==`,
        "stdout-2\nstdout-3",
        `== stderr (${root}/daemon/stderr.log) ==`,
        "stderr-1\nstderr-2",
      ].join("\n"),
    });
  });

  it("[UC-DAEMON-04-S06] selects stdout without reading stderr or run logs", () => {
    const root = createTmpDir();
    writeDaemonLogs(root, {
      stdout: "daemon stdout\n",
      stderr: "daemon stderr\n",
    });
    mkdirSync(join(root, "runs", "run-1"), { recursive: true });
    writeFileSync(join(root, "runs", "run-1", "stdout.log"), "run stdout\n", "utf8");

    const result = readDaemonLogs({
      root,
      stream: "stdout",
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.output).toContain("daemon stdout");
    expect(result.output).not.toContain("daemon stderr");
    expect(result.output).not.toContain("run stdout");
  });

  it("[UC-DAEMON-04-S07] reports a clear error when daemon logs are unavailable", () => {
    const root = createTmpDir();

    expect(readDaemonLogs({ root })).toEqual({
      ok: false,
      message: `Daemon logs are not available because ${root}/daemon does not exist. Run \`grovie daemon start\` first.`,
    });
  });

  it("[UC-DAEMON-04-S07] builds a follow command for the selected daemon stream", () => {
    const root = createTmpDir();

    expect(buildTailDaemonLogsArgs({
      root,
      stream: "stderr",
      lines: 25,
    })).toEqual([
      "-n",
      "25",
      "-f",
      `${root}/daemon/stderr.log`,
    ]);
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-daemon-logs-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeDaemonLogs(root: string, input: { stdout: string; stderr: string }): void {
  const daemonDir = join(root, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(daemonDir, "stdout.log"), input.stdout, "utf8");
  writeFileSync(join(daemonDir, "stderr.log"), input.stderr, "utf8");
}
