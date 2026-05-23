import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWatchedRepository,
  loadConfig,
  loadGlobalConfig,
  parseGitHubRemote,
  removeWatchedRepository,
  renderDefaultConfig,
  renderGlobalConfig,
  saveGlobalConfig,
} from "../src/config.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("config helpers", () => {
  it("parses supported GitHub origin URL formats", () => {
    expect(parseGitHubRemote("git@github.com:fankaidev/grovie.git")).toBe("fankaidev/grovie");
    expect(parseGitHubRemote("https://github.com/fankaidev/grovie.git")).toBe("fankaidev/grovie");
    expect(parseGitHubRemote("ssh://git@github.com/fankaidev/grovie.git")).toBe("fankaidev/grovie");
  });

  it("ignores non-GitHub remotes", () => {
    expect(parseGitHubRemote("git@example.com:fankaidev/grovie.git")).toBeUndefined();
  });

  it("renders safe defaults", () => {
    const config = renderDefaultConfig();

    expect(config).not.toContain("repository:");
    expect(config).toContain("default: codex");
    expect(config).toContain("label: grovie");
    expect(config).toContain("allowDefaultBranchPush: false");
  });

  it("uses safe defaults when no config file exists", () => {
    const cwd = createTmpDir();

    const loaded = loadConfig(cwd);

    expect(loaded.path).toBeUndefined();
    expect(loaded.config).toMatchObject({
      version: 1,
      runtime: {
        default: "codex",
      },
      queue: {
        label: "grovie",
      },
    });
  });

  it("[UC-EXECUTION-06-S04] accepts supported explicit runtime names", () => {
    for (const runtime of ["cc", "pi", "opencode", "hermes"]) {
      const cwd = createTmpDir();
      writeFileSync(
        join(cwd, ".grovie.yml"),
        renderDefaultConfig().replace("default: codex", `default: ${runtime}`),
        "utf8",
      );

      expect(loadConfig(cwd).config.runtime.default).toBe(runtime);
    }
  });

  it("rejects unsafe and unknown nested config values", () => {
    const cwd = createTmpDir();
    writeFileSync(
      join(cwd, ".grovie.yml"),
      [
        "version: 1",
        "runtime:",
        "  default: codex",
        "queue:",
        "  label: grovie",
        "branches:",
        "  prefix: grovie/",
        "worktrees:",
        "  cleanup: on-success",
        "pullRequests:",
        "  create: true",
        "  draft: false",
        "comments:",
        "  mode: concise",
        "safety:",
        "  allowDefaultBranchPush: true",
        "  forcePush: true",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadConfig(cwd)).toThrow("safety.allowDefaultBranchPush: Invalid input: expected false");
    expect(() => loadConfig(cwd)).toThrow("safety: Unrecognized key: \"forcePush\"");
  });

  it("rejects the old repositories allowlist shape", () => {
    const cwd = createTmpDir();
    writeFileSync(
      join(cwd, ".grovie.yml"),
      [
        "version: 1",
        "repositories:",
        "  allowed:",
        "    - fankaidev/grovie",
        "runtime:",
        "  default: codex",
        "queue:",
        "  label: grovie",
        "branches:",
        "  prefix: grovie/",
        "worktrees:",
        "  cleanup: on-success",
        "pullRequests:",
        "  create: true",
        "  draft: false",
        "comments:",
        "  mode: concise",
        "safety:",
        "  allowDefaultBranchPush: false",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadConfig(cwd)).toThrow("Unrecognized key: \"repositories\"");
  });

  it("[UC-ADMIN-01-S01] loads an empty global worker config with the admin console disabled when config.yml is absent", () => {
    const root = createTmpDir();

    expect(loadGlobalConfig(root)).toEqual({
      path: join(root, "config.yml"),
      config: {
        version: 1,
        watchedRepositories: [],
        adminConsole: {
          enabled: false,
        },
      },
    });
  });

  it("[UC-ADMIN-01-S01] keeps the admin console disabled by default", () => {
    const root = createTmpDir();

    expect(loadGlobalConfig(root).config.adminConsole).toEqual({
      enabled: false,
    });
  });

  it("[UC-ADMIN-01-S05] rejects non-local admin console bind hosts", () => {
    const root = createTmpDir();
    writeFileSync(
      join(root, "config.yml"),
      [
        "version: 1",
        "watchedRepositories: []",
        "adminConsole:",
        "  enabled: true",
        "  host: 0.0.0.0",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadGlobalConfig(root)).toThrow("adminConsole.host: Invalid input: expected \"127.0.0.1\"");
  });

  it("[UC-WORKER-02-S01] [UC-WORKER-02-S02] [UC-ADMIN-01-S01] saves watched repositories without enabling the admin console", () => {
    const root = createTmpDir();
    const added = addWatchedRepository(loadGlobalConfig(root).config, {
      repository: "fankaidev/grovie",
      label: "ready",
    });

    saveGlobalConfig(root, added);

    expect(loadGlobalConfig(root).config).toEqual({
      version: 1,
      watchedRepositories: [
        {
          repository: "fankaidev/grovie",
          label: "ready",
        },
      ],
      adminConsole: {
        enabled: false,
      },
    });

    const removed = removeWatchedRepository(loadGlobalConfig(root).config, "fankaidev/grovie");
    expect(removed.watchedRepositories).toEqual([]);
  });

  it("renders global config as a scheduling list, not an allowlist", () => {
    const config = renderGlobalConfig({
      version: 1,
      watchedRepositories: [
        {
          repository: "fankaidev/grovie",
        },
      ],
    });

    expect(config).toContain("schedules repositories");
    expect(config).toContain("not a security allowlist");
    expect(config).toContain("repository: fankaidev/grovie");
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-config-"));
  tmpDirs.push(dir);
  return dir;
}
