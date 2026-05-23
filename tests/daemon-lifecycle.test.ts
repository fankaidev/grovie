import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDaemonLifecycle, type DaemonLifecycleState } from "../src/daemon-lifecycle.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LocalDaemonLifecycle", () => {
  it("[UC-WORKER-06-S03] refuses to stop a live pid that does not match the recorded Grovie daemon token", () => {
    const root = createTmpDir();
    let verifiedState: DaemonLifecycleState | undefined;
    const lifecycle = new LocalDaemonLifecycle((state) => {
      verifiedState = state;
      return false;
    });

    const startResult = lifecycle.start({
      root,
      args: ["start", "--once"],
    });

    expect(startResult.ok).toBe(true);

    if (!startResult.ok) {
      throw new Error(startResult.message);
    }

    expect(lifecycle.stop({ root })).toEqual({
      ok: false,
      message: `Refusing to stop pid ${startResult.state.pid} because it does not match the recorded Grovie daemon token.`,
    });
    expect(verifiedState?.token).toBe(startResult.state.token);

    try {
      process.kill(startResult.state.pid, "SIGTERM");
    } catch {
      // The detached process may have exited before cleanup.
    }
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-daemon-lifecycle-test-"));
  tmpDirs.push(dir);
  return dir;
}
