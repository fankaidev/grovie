import { describe, expect, it } from "vitest";
import { commands, renderHelp, runCli } from "../src/cli-app.js";

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

  it("returns a clear stub response for init", () => {
    expect(runCli(["init"])).toEqual({
      exitCode: 0,
      stdout: "grovie init\n\nConfig initialization will be implemented in #3.",
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
