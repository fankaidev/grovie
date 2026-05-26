import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWatchedRepository,
  loadGlobalConfig,
  parseGitHubRemote,
  removeWatchedRepository,
  renderGlobalConfig,
  resolveRepositoryConfig,
  resolveWatchedRepositoryConfig,
  saveGlobalConfig,
} from "../src/config.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("config helpers", () => {
  it("[UC-EXECUTION-01-S01] parses supported GitHub origin URL formats", () => {
    expect(parseGitHubRemote("git@github.com:fankaidev/grovie.git")).toBe("fankaidev/grovie");
    expect(parseGitHubRemote("https://github.com/fankaidev/grovie.git")).toBe("fankaidev/grovie");
    expect(parseGitHubRemote("ssh://git@github.com/fankaidev/grovie.git")).toBe("fankaidev/grovie");
  });

  it("[UC-EXECUTION-01-S01] ignores non-GitHub remotes", () => {
    expect(parseGitHubRemote("git@example.com:fankaidev/grovie.git")).toBeUndefined();
  });

  it("[UC-WORKER-04-S12] resolves repository policy from watchedRepositories", () => {
    const config = resolveWatchedRepositoryConfig({
      repository: "fankaidev/grovie",
      label: "ready",
      branches: {
        prefix: "ai/",
      },
      trust: {
        trustedAuthors: ["fankaidev", "trusted-user"],
      },
    });

    expect(config).toEqual({
      queue: {
        label: "ready",
      },
      branches: {
        prefix: "ai/",
      },
      trust: {
        trustedAuthors: ["fankaidev", "trusted-user"],
      },
      safety: {
        allowDefaultBranchPush: false,
      },
    });
  });

  it("[UC-WORKER-04-S12] uses safe repository policy defaults for unconfigured repositories", () => {
    const root = createTmpDir();
    const globalConfig = loadGlobalConfig(root);
    const loaded = resolveRepositoryConfig("fankaidev/grovie", globalConfig);

    expect(loaded.path).toBe(join(root, "config.yml"));
    expect(loaded.config.queue.label).toBe("grovie");
    expect(loaded.config.safety.allowDefaultBranchPush).toBe(false);
  });

  it("[UC-WORKER-04-S12] allows watched repositories to omit trust policy", () => {
    const root = createTmpDir();
    writeFileSync(
      join(root, "config.yml"),
      [
        "version: 1",
        "agents: []",
        "watchedRepositories:",
        "  - repository: fankaidev/grovie",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(loadGlobalConfig(root).config.watchedRepositories).toEqual([
      {
        repository: "fankaidev/grovie",
      },
    ]);
  });

  it("[UC-ADMIN-01-S01] loads an empty global worker config with the admin console disabled when config.yml is absent", () => {
    const root = createTmpDir();

    expect(loadGlobalConfig(root)).toEqual({
      path: join(root, "config.yml"),
      config: {
        version: 1,
        agents: [],
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
        "agents: []",
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

  it("[UC-WORKER-01-S04] requires explicit agents in config.yml", () => {
    const root = createTmpDir();
    writeFileSync(
      join(root, "config.yml"),
      [
        "version: 1",
        "watchedRepositories: []",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadGlobalConfig(root)).toThrow("agents: Invalid input: expected array");
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
      agents: [],
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

  it("[UC-WORKER-02-S01] renders global config as a scheduling list, not an allowlist", () => {
    const config = renderGlobalConfig({
      version: 1,
      agents: [],
      watchedRepositories: [
        {
          repository: "fankaidev/grovie",
        },
      ],
      stateRepo: {
        enabled: true,
        repository: "fankaidev/grovie-state",
        branch: "main",
        syncIntervalSeconds: 60,
      },
    });

    expect(config).toContain("schedules repositories");
    expect(config).toContain("not a security allowlist");
    expect(config).toContain("repository: fankaidev/grovie");
    expect(config).toContain("stateRepo:");
    expect(config).toContain("repository: fankaidev/grovie-state");
    expect(config).toContain("Redaction is best-effort");
  });

  it("[UC-WORKER-02-S01] round-trips schema-valid global config strings through rendered YAML", () => {
    const root = createTmpDir();
    const rendered = renderGlobalConfig({
      version: 1,
      agents: [
        {
          name: "coder",
          runtime: "codex",
          instructions: "Use #tag\nKeep a: b literal.",
          model: "gpt: 5",
          envKeys: ["OPENAI_API_KEY", "KEY:VALUE"],
        },
      ],
      watchedRepositories: [
        {
          repository: "fankaidev/grovie",
          label: "ready #1",
        },
      ],
      stateRepo: {
        enabled: false,
        repository: "fankaidev/grovie-state",
        branch: "main: dev",
        syncIntervalSeconds: 60,
      },
      adminConsole: {
        enabled: true,
        host: "127.0.0.1",
        port: 4317,
      },
    });

    writeFileSync(join(root, "config.yml"), rendered, "utf8");

    expect(loadGlobalConfig(root).config).toEqual({
      version: 1,
      agents: [
        {
          name: "coder",
          runtime: "codex",
          instructions: "Use #tag\nKeep a: b literal.",
          model: "gpt: 5",
          envKeys: ["OPENAI_API_KEY", "KEY:VALUE"],
        },
      ],
      watchedRepositories: [
        {
          repository: "fankaidev/grovie",
          label: "ready #1",
        },
      ],
      stateRepo: {
        enabled: false,
        repository: "fankaidev/grovie-state",
        branch: "main: dev",
        syncIntervalSeconds: 60,
      },
      adminConsole: {
        enabled: true,
        host: "127.0.0.1",
        port: 4317,
      },
    });
  });

  it("[UC-WORKER-01-S05] validates explicit global agent config without environment values", () => {
    const root = createTmpDir();
    writeFileSync(
      join(root, "config.yml"),
      [
        "version: 1",
        "agents:",
        "  - name: coder",
        "    runtime: codex",
        "    envKeys:",
        "      - OPENAI_API_KEY",
        "watchedRepositories: []",
        "adminConsole:",
        "  enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(loadGlobalConfig(root).config.agents).toEqual([
      {
        name: "coder",
        runtime: "codex",
        envKeys: ["OPENAI_API_KEY"],
      },
    ]);
  });

  it("[UC-EXECUTION-06-S04] accepts supported runtime names and rejects retired runtime names", () => {
    const root = createTmpDir();

    for (const runtime of ["codex", "claude-code", "pi"]) {
      writeFileSync(
        join(root, "config.yml"),
        [
          "version: 1",
          "agents:",
          "  - name: coder",
          `    runtime: ${runtime}`,
          "watchedRepositories: []",
          "adminConsole:",
          "  enabled: false",
          "",
        ].join("\n"),
        "utf8",
      );

      expect(loadGlobalConfig(root).config.agents[0]?.runtime).toBe(runtime);
    }

    for (const runtime of ["cc", "opencode", "hermes"]) {
      writeFileSync(
        join(root, "config.yml"),
        [
          "version: 1",
          "agents:",
          "  - name: coder",
          `    runtime: ${runtime}`,
          "watchedRepositories: []",
          "adminConsole:",
          "  enabled: false",
          "",
        ].join("\n"),
        "utf8",
      );

      expect(() => loadGlobalConfig(root)).toThrow("agents.0.runtime");
    }
  });

  it("[UC-WORKER-02-S05] validates optional global state repository config", () => {
    const root = createTmpDir();
    writeFileSync(
      join(root, "config.yml"),
      [
        "version: 1",
        "agents: []",
        "watchedRepositories: []",
        "stateRepo:",
        "  enabled: true",
        "  repository: fankaidev/grovie-state",
        "  branch: main",
        "  syncIntervalSeconds: 60",
        "adminConsole:",
        "  enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(loadGlobalConfig(root).config.stateRepo).toEqual({
      enabled: true,
      repository: "fankaidev/grovie-state",
      branch: "main",
      syncIntervalSeconds: 60,
    });
  });

  it("[UC-STATE-REPO-01-S07] rejects unsafe state repository sync intervals", () => {
    const root = createTmpDir();
    writeFileSync(
      join(root, "config.yml"),
      [
        "version: 1",
        "watchedRepositories: []",
        "stateRepo:",
        "  enabled: true",
        "  repository: fankaidev/grovie-state",
        "  branch: main",
        "  syncIntervalSeconds: 1",
        "adminConsole:",
        "  enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadGlobalConfig(root)).toThrow("stateRepo.syncIntervalSeconds");
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-config-"));
  tmpDirs.push(dir);
  return dir;
}
