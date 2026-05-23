import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDaemonService, uninstallDaemonService } from "../src/daemon-service.js";
import type { LocalStatePaths } from "../src/local-state.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("daemon service integration", () => {
  it("[UC-WORKER-06-S09] installs a macOS LaunchAgent file for the local daemon", () => {
    const root = createTmpDir();
    const home = createTmpDir();
    const result = installDaemonService({
      paths: paths(root),
      platform: "launchd",
      home,
      entrypoint: "/usr/local/bin/grovie",
    });

    expect(result).toEqual({
      platform: "launchd",
      path: join(home, "Library", "LaunchAgents", "dev.grovie.daemon.plist"),
      action: "installed",
    });
    expect(readFileSync(result.path, "utf8")).toContain("<string>/usr/local/bin/grovie</string>");
    expect(readFileSync(result.path, "utf8")).toContain("<string>daemon</string>");
    expect(readFileSync(result.path, "utf8")).toContain(`<string>${root}/daemon/stdout.log</string>`);
  });

  it("[UC-WORKER-06-S10] installs a Linux systemd user service file for the local daemon", () => {
    const root = createTmpDir();
    const home = createTmpDir();
    const result = installDaemonService({
      paths: paths(root),
      platform: "systemd",
      home,
      entrypoint: "/usr/local/bin/grovie",
    });

    expect(result).toEqual({
      platform: "systemd",
      path: join(home, ".config", "systemd", "user", "grovie.service"),
      action: "installed",
    });
    expect(readFileSync(result.path, "utf8")).toContain("ExecStart=");
    expect(readFileSync(result.path, "utf8")).toContain("/usr/local/bin/grovie daemon run");
    expect(readFileSync(result.path, "utf8")).toContain(`StandardOutput=append:${root}/daemon/stdout.log`);
  });

  it("[UC-WORKER-06-S11] uninstalls only the generated user service file", () => {
    const root = createTmpDir();
    const home = createTmpDir();
    const installed = installDaemonService({
      paths: paths(root),
      platform: "systemd",
      home,
      entrypoint: "/usr/local/bin/grovie",
    });

    expect(existsSync(installed.path)).toBe(true);

    const result = uninstallDaemonService({
      paths: paths(root),
      platform: "systemd",
      home,
    });

    expect(result).toEqual({
      platform: "systemd",
      path: installed.path,
      action: "uninstalled",
    });
    expect(existsSync(installed.path)).toBe(false);
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-daemon-service-"));
  tmpDirs.push(dir);
  return dir;
}

function paths(root: string): LocalStatePaths {
  return {
    root,
    reposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir: join(root, "runs"),
    agentsDir: join(root, "agents"),
    locksDir: join(root, "locks"),
    requestsDir: join(root, "requests"),
    sessionsDir: join(root, "sessions"),
  };
}
