import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, renderHelp, runCli, runCliAsync } from "../src/cli-app.js";
import type { GitHubGateway } from "../src/github.js";
import type { AgentRuntime, RuntimeAvailability } from "../src/runtime.js";

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

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime() })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Invalid .grovie.yml:"),
    });
  });

  it("rejects unknown config fields through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });
    writeFileSync(join(cwd, ".grovie.yml"), `${readFileSync(join(cwd, ".grovie.yml"), "utf8")}unsupported: true\n`, "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime() })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Unrecognized key: \"unsupported\""),
    });
  });

  it("validates the default config through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime() })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "",
        `Config: ${join(cwd, ".grovie.yml")} is valid.`,
        "Allowed repositories: fankaidev/grovie",
        "Default runtime: codex",
        "Queue label: grovie",
        "GitHub: authenticated as fankaidev.",
        "Codex: available (codex-cli 0.133.0).",
      ].join("\n"),
    });
  });

  it("reports unavailable Codex runtime through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway(),
        runtime: fakeRuntime({
          available: false,
          message: "codex command not found",
        }),
      }),
    ).toEqual({
      exitCode: 1,
      stdout: [
        "grovie doctor",
        "",
        `Config: ${join(cwd, ".grovie.yml")} is valid.`,
        "Allowed repositories: fankaidev/grovie",
        "Default runtime: codex",
        "Queue label: grovie",
        "GitHub: authenticated as fankaidev.",
        "Codex: codex command not found.",
      ].join("\n"),
      stderr: "Codex runtime is not available. Install the Codex CLI or choose another runtime when one is supported.",
    });
  });

  it("reports GitHub authentication errors through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway({
          getAuthenticatedUser: () => ({
            ok: false,
            error: {
              code: "gh_failed",
              message: "gh auth required",
            },
          }),
        }),
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "gh auth required",
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
    const cwd = createTmpDir();

    expect(runCli(["run", "--agent", "codex", "fankaidev/grovie#2"], { cwd })).toEqual({
      exitCode: 1,
      stderr: "Missing .grovie.yml. Run `grovie init` first.",
    });
  });

  it("rejects unsupported run agents", () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });

    expect(runCli(["run", "fankaidev/grovie#2", "--agent", "claude"], { cwd })).toEqual({
      exitCode: 1,
      stderr: "Unsupported agent runtime: claude. Only codex is supported.",
    });
  });

  it("runs one daemon polling cycle with the configured repository and label", async () => {
    const cwd = createTmpDir();
    runCli(["init", "--repo", "fankaidev/grovie"], { cwd });

    expect(
      await runCliAsync(["daemon", "--once"], {
        cwd,
        github: fakeGitHubGateway({
          listOpenIssues: (repository, label) => {
            expect(repository).toBe("fankaidev/grovie");
            expect(label).toBe("grovie");

            return {
              ok: true,
              value: [],
            };
          },
        }),
        runtime: fakeRuntime(),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie daemon",
        "",
        "No queued issues found for fankaidev/grovie with label grovie.",
      ].join("\n"),
    });
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-test-"));
  tmpDirs.push(dir);
  return dir;
}

function fakeRuntime(availability: Partial<RuntimeAvailability> = {}): AgentRuntime {
  return {
    name: "codex",
    checkAvailability: () => ({
      runtime: "codex",
      command: "codex",
      available: true,
      version: "codex-cli 0.133.0",
      message: "available (codex-cli 0.133.0)",
      ...availability,
    }),
    run: () => {
      throw new Error("runtime run was not expected");
    },
  };
}

function fakeGitHubGateway(overrides: Partial<GitHubGateway> = {}): GitHubGateway {
  return {
    getAuthenticatedUser: () => ({
      ok: true,
      value: {
        login: "fankaidev",
      },
    }),
    readIssue: () => {
      throw new Error("readIssue was not expected");
    },
    listOpenIssues: () => {
      throw new Error("listOpenIssues was not expected");
    },
    addLabels: () => {
      throw new Error("addLabels was not expected");
    },
    removeLabel: () => {
      throw new Error("removeLabel was not expected");
    },
    createIssueComment: () => {
      throw new Error("createIssueComment was not expected");
    },
    updateIssueComment: () => {
      throw new Error("updateIssueComment was not expected");
    },
    createPullRequest: () => {
      throw new Error("createPullRequest was not expected");
    },
    ...overrides,
  };
}
