import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, parseGitHubRemote, renderDefaultConfig } from "../src/config.js";

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
    const config = renderDefaultConfig("fankaidev/grovie");

    expect(config).toContain("allowed:");
    expect(config).toContain("- fankaidev/grovie");
    expect(config).toContain("default: codex");
    expect(config).toContain("label: grovie");
    expect(config).toContain("allowDefaultBranchPush: false");
  });

  it("rejects unsafe and unknown nested config values", () => {
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
        "  allowDefaultBranchPush: true",
        "  forcePush: true",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => loadConfig(cwd)).toThrow("safety.allowDefaultBranchPush: Invalid input: expected false");
    expect(() => loadConfig(cwd)).toThrow("safety: Unrecognized key: \"forcePush\"");
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-config-"));
  tmpDirs.push(dir);
  return dir;
}
