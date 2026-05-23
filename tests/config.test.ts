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

  it("loads an empty global worker config when config.yml is absent", () => {
    const root = createTmpDir();

    expect(loadGlobalConfig(root)).toEqual({
      path: join(root, "config.yml"),
      config: {
        version: 1,
        watchedRepositories: [],
      },
    });
  });

  it("saves and updates watched repositories in the global worker config", () => {
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
