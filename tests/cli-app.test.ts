import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, renderHelp, runCli } from "../src/cli-app.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI command registration", () => {
  it("registers the MVP command set", () => {
    expect(commands.map((command) => command.name)).toEqual(["init", "doctor", "run", "daemon"]);
  });

  it("renders help with the MVP commands", () => {
    const help = renderHelp();

    expect(help).toContain("grovie <command>");
    expect(help).toContain("init");
    expect(help).toContain("doctor");
    expect(help).toContain("run");
    expect(help).toContain("daemon");
  });

  it("accepts pnpm script argument separators", () => {
    expect(runCli(["--", "--help"])).toEqual({
      exitCode: 0,
      stdout: renderHelp(),
    });
  });

  it("writes the default config with an explicit repository", () => {
    const cwd = createTmpDir();

    expect(runCli(["init", "--repo", "fankaidev/grovie"], { cwd })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie init",
        "",
        "Created .grovie.yml for fankaidev/grovie.",
        "Run `grovie doctor` to validate it.",
      ].join("\n"),
    });

    expect(readFileSync(join(cwd, ".grovie.yml"), "utf8")).toContain("- fankaidev/grovie");
  });

  it("reports invalid config fields through doctor", () => {
    const cwd = createTmpDir();
    writeFileSync(join(cwd, ".grovie.yml"), "version: 1\nsafety:\n  allowDefaultBranchPush: true\n", "utf8");

    expect(runCli(["doctor"], { cwd })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Invalid .grovie.yml:"),
    });
  });

  it("validates the default config through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });

    expect(runCli(["doctor"], { cwd })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "",
        `Config: ${join(cwd, ".grovie.yml")} is valid.`,
        "Allowed repositories: fankaidev/grovie",
        "Default runtime: codex",
        "Queue label: grovie",
        "Environment checks will be implemented in #4 and #6.",
      ].join("\n"),
    });
  });

  it("requires an issue reference for run", () => {
    expect(runCli(["run"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
    });
  });

  it("does not treat option values as issue references", () => {
    expect(runCli(["run", "--agent", "codex"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
    });
  });

  it("rejects malformed issue references with extra path segments", () => {
    expect(runCli(["run", "fankaidev/grovie/extra#2"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 --agent codex",
    });
  });

  it("accepts the issue reference after options", () => {
    expect(runCli(["run", "--agent", "codex", "fankaidev/grovie#2"])).toEqual({
      exitCode: 0,
      stdout: "grovie run\n\nOne-shot execution for fankaidev/grovie#2 will be implemented in #7.",
    });
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-test-"));
  tmpDirs.push(dir);
  return dir;
}
