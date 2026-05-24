import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalState } from "./local-state.js";

export type DaemonLifecycleState = {
  pid: number;
  command: string[];
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
  statePath: string;
  token: string;
};

export type DaemonLifecycleStatus =
  | {
    status: "stopped";
    daemonDir: string;
  }
  | {
    status: "running" | "stale";
    state: DaemonLifecycleState;
  };

export type DaemonLifecycle = {
  start(input: { root: string; args: string[] }): { ok: true; state: DaemonLifecycleState } | { ok: false; message: string };
  stop(input: { root: string }): { ok: true; message: string } | { ok: false; message: string };
  status(input: { root: string }): DaemonLifecycleStatus;
};

type ProcessVerifier = (state: DaemonLifecycleState) => boolean;

export class LocalDaemonLifecycle implements DaemonLifecycle {
  constructor(private readonly verifyProcess: ProcessVerifier = verifyGrovieDaemonProcess) {}

  start(input: { root: string; args: string[] }): { ok: true; state: DaemonLifecycleState } | { ok: false; message: string } {
    const currentStatus = this.status(input);

    if (currentStatus.status === "running") {
      return {
        ok: false,
        message: `Grovie daemon already appears to be running with pid ${currentStatus.state.pid}.`,
      };
    }

    const daemonDir = getDaemonDir(input.root);
    mkdirSync(daemonDir, { recursive: true });

    const stdoutPath = join(daemonDir, "stdout.log");
    const stderrPath = join(daemonDir, "stderr.log");
    const entrypoint = process.argv[1];

    if (entrypoint === undefined) {
      return {
        ok: false,
        message: "Cannot start daemon: current CLI entrypoint is unknown.",
      };
    }

    const token = randomUUID();
    const command = [process.execPath, entrypoint, "daemon", "run", ...input.args.filter((arg) => arg !== "start")];
    const stdoutFd = openSync(stdoutPath, "a");
    const stderrFd = openSync(stderrPath, "a");

    let child;

    try {
      child = spawn(command[0] ?? process.execPath, command.slice(1), {
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: {
          ...process.env,
          GROVIE_DAEMON_TOKEN: token,
        },
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    child.unref();

    const state = {
      pid: child.pid ?? -1,
      command,
      startedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      statePath: getStatePath(input.root),
      token,
    };

    writeFileSync(state.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    return {
      ok: true,
      state,
    };
  }

  stop(input: { root: string }): { ok: true; message: string } | { ok: false; message: string } {
    const currentStatus = this.status(input);

    if (currentStatus.status === "stopped") {
      return {
        ok: true,
        message: "Grovie daemon is stopped.",
      };
    }

    if (currentStatus.status === "stale") {
      removeState(currentStatus.state.statePath);
      return {
        ok: true,
        message: `Removed stale daemon state for pid ${currentStatus.state.pid}.`,
      };
    }

    if (!this.verifyProcess(currentStatus.state)) {
      return {
        ok: false,
        message: `Refusing to stop pid ${currentStatus.state.pid} because it does not match the recorded Grovie daemon token.`,
      };
    }

    const interrupted = new LocalState({ paths: { root: input.root } }).interruptActiveRuns({
      reason: "Daemon stopped.",
    });

    try {
      process.kill(currentStatus.state.pid, "SIGTERM");
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    removeState(currentStatus.state.statePath);

    return {
      ok: true,
      message: [
        `Stopped Grovie daemon pid ${currentStatus.state.pid}.`,
        interrupted.length === 0 ? undefined : `Interrupted resumable runs: ${interrupted.map((run) => run.runId).join(", ")}.`,
      ].filter((line): line is string => line !== undefined).join("\n"),
    };
  }

  status(input: { root: string }): DaemonLifecycleStatus {
    const statePath = getStatePath(input.root);
    const state = readState(statePath);

    if (state === undefined) {
      return {
        status: "stopped",
        daemonDir: getDaemonDir(input.root),
      };
    }

    return {
      status: isLivePid(state.pid) ? "running" : "stale",
      state,
    };
  }
}

export function renderDaemonLifecycleStatus(status: DaemonLifecycleStatus): string {
  if (status.status === "stopped") {
    return [
      "grovie daemon status",
      "",
      "Status: stopped",
      `Daemon directory: ${status.daemonDir}`,
    ].join("\n");
  }

  return [
    "grovie daemon status",
    "",
    `Status: ${status.status}`,
    `Pid: ${status.state.pid}`,
    `Started at: ${status.state.startedAt}`,
    `Stdout log: ${status.state.stdoutPath}`,
    `Stderr log: ${status.state.stderrPath}`,
    `State: ${status.state.statePath}`,
  ].join("\n");
}

function getDaemonDir(root: string): string {
  return join(root, "daemon");
}

function getStatePath(root: string): string {
  return join(getDaemonDir(root), "daemon.json");
}

function readState(path: string): DaemonLifecycleState | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonLifecycleState>;

    if (typeof parsed.pid !== "number" || !Array.isArray(parsed.command) || typeof parsed.token !== "string") {
      return undefined;
    }

    return {
      pid: parsed.pid,
      command: parsed.command,
      startedAt: parsed.startedAt ?? "",
      stdoutPath: parsed.stdoutPath ?? "",
      stderrPath: parsed.stderrPath ?? "",
      statePath: parsed.statePath ?? path,
      token: parsed.token,
    };
  } catch {
    return undefined;
  }
}

function verifyGrovieDaemonProcess(state: DaemonLifecycleState): boolean {
  if (state.token.length === 0) {
    return false;
  }

  const result = spawnSync("ps", ["eww", "-p", String(state.pid)], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return false;
  }

  return result.stdout.includes(`GROVIE_DAEMON_TOKEN=${state.token}`);
}

function removeState(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Ignore already-removed lifecycle state.
  }
}

function isLivePid(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
