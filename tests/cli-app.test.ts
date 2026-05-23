import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, renderHelp, runCli, runCliAsync } from "../src/cli-app.js";
import type { DaemonLifecycle, DaemonLifecycleStatus } from "../src/daemon-lifecycle.js";
import { type AgentMetadata, resolveMachineId } from "../src/identity.js";
import { GROVIE_VERSION } from "../src/version.js";
import type { CreatedComment, GitHubGateway, GitHubIssue, IssueReference } from "../src/github.js";
import type { HandledCursor, LocalStatePaths, PreparedRun, RunRequest } from "../src/local-state.js";
import type { RunLocalState } from "../src/run.js";
import type { AgentRunInput, AgentRuntime, RuntimeAvailability } from "../src/runtime.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI command registration", () => {
  it("[UC-WORKER-03-S01] [UC-WORKER-05-S01] [UC-ADMIN-01-S02] registers issue assignment, queue, daemon, and admin commands", () => {
    expect(commands.map((command) => command.name)).toEqual(["init", "doctor", "status", "runs", "issue", "run", "queue", "daemon", "admin", "watch"]);
  });

  it("[UC-WORKER-05-S01] [UC-WORKER-06-S01] [UC-ADMIN-01-S02] renders help with queue, daemon, and admin commands", () => {
    const help = renderHelp();

    expect(help).toContain("grovie <command>");
    expect(help).toContain("-v, --version");
    expect(help).toContain("init");
    expect(help).toContain("doctor");
    expect(help).toContain("status");
    expect(help).toContain("runs");
    expect(help).toContain("run");
    expect(help).toContain("queue");
    expect(help).toContain("daemon");
    expect(help).toContain("admin");
    expect(help).toContain("watch");
  });

  it("accepts pnpm script argument separators", () => {
    expect(runCli(["--", "--help"])).toEqual({
      exitCode: 0,
      stdout: renderHelp(),
    });
  });

  it("reports the package version through long and short flags", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

    expect(GROVIE_VERSION).toBe(packageVersion.version);
    expect(runCli(["--version"])).toEqual({
      exitCode: 0,
      stdout: "0.1.0",
    });
    expect(runCli(["-v"])).toEqual({
      exitCode: 0,
      stdout: "0.1.0",
    });
  });

  it("writes the default policy config", () => {
    const cwd = createTmpDir();

    expect(runCli(["init"], { cwd })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie init",
        "",
        "Created .grovie.yml.",
        "Run `grovie doctor` to validate it.",
      ].join("\n"),
    });

    expect(readFileSync(join(cwd, ".grovie.yml"), "utf8")).not.toContain("repository:");
  });

  it("reports invalid config fields through doctor", () => {
    const cwd = createTmpDir();
    writeFileSync(join(cwd, ".grovie.yml"), "version: 1\nsafety:\n  allowDefaultBranchPush: true\n", "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState: new FakeLocalState(createTmpDir()) })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Invalid .grovie.yml:"),
    });
  });

  it("rejects unknown config fields through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });
    writeFileSync(join(cwd, ".grovie.yml"), `${readFileSync(join(cwd, ".grovie.yml"), "utf8")}unsupported: true\n`, "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState: new FakeLocalState(createTmpDir()) })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Unrecognized key: \"unsupported\""),
    });
  });

  it("[UC-WORKER-01-S04] validates the default local agent through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "",
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Local policy config: ${join(cwd, ".grovie.yml")} is valid.`,
        `Machine id: ${machineId}`,
        `Default agent: default@${machineId} (codex)`,
        "Default runtime: codex",
        "Queue label: grovie",
        "GitHub: authenticated as fankaidev.",
        "Codex: available (codex-cli 0.133.0).",
      ].join("\n"),
    });
    expect(localState.registeredAgents).toEqual([
      expect.objectContaining({
        agentId: `default@${machineId}`,
        machineId,
        runtime: "codex",
        envKeys: ["OPENAI_API_KEY"],
      }),
    ]);
  });

  it("[UC-WORKER-01-S04] [UC-EXECUTION-03-S02] reports unavailable Codex runtime through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });
    const globalRoot = createTmpDir();
    const machineId = resolveMachineId(hostname());

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway(),
        localState: new FakeLocalState(globalRoot),
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
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Local policy config: ${join(cwd, ".grovie.yml")} is valid.`,
        `Machine id: ${machineId}`,
        `Default agent: default@${machineId} (codex)`,
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
    runCli(["init"], { cwd });

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
        localState: new FakeLocalState(createTmpDir()),
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "gh auth required",
    });
  });

  it("[UC-ADMIN-01-S01] fails clearly when the admin console is disabled", async () => {
    const localState = new FakeLocalState(createTmpDir());

    await expect(runCliAsync(["admin", "serve"], { localState })).resolves.toEqual({
      exitCode: 1,
      stderr: "Admin console is disabled. Set adminConsole.enabled: true in the global config.",
    });
  });

  it("[UC-WORKER-06-S08] shows daemon state, watched repositories, useful paths, active runs, and failures through status", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });
    writeLocalRun(localState.paths.runsDir, "active-run", {
      metadata: {
        runId: "active-run",
        repository: "fankaidev/grovie",
        issueNumber: 36,
        branchName: "grovie/issue-36",
        worktreePath: "/tmp/grovie/worktrees/active-run",
      },
      events: [
        {
          timestamp: "2999-05-23T10:00:00.000Z",
          type: "runtime.started",
          data: {
            runtime: "codex",
          },
        },
      ],
    });

    const result = runCli(["status"], { cwd, localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("grovie status");
    expect(result.stdout).toContain("Daemon:");
    expect(result.stdout).toContain("Status: stopped");
    expect(result.stdout).toContain("- fankaidev/grovie");
    expect(result.stdout).toContain(`Runs: ${localState.paths.runsDir}`);
    expect(result.stdout).toContain("active-run fankaidev/grovie#36 status=running");
  });

  it("[UC-EXECUTION-02-S07] [UC-EXECUTION-02-S08] lists and shows local runs through runs subcommands", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    writeLocalRun(localState.paths.runsDir, "failed-run", {
      metadata: {
        runId: "failed-run",
        repository: "fankaidev/grovie",
        issueNumber: 37,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-37",
        localBranchName: "grovie/issue-37-attempt",
        worktreePath: "/tmp/grovie/worktrees/failed-run",
      },
      events: [
        {
          timestamp: "2026-05-23T10:00:00.000Z",
          type: "runtime.started",
          data: {
            runtime: "codex",
          },
        },
        {
          timestamp: "2026-05-23T10:00:30.000Z",
          type: "comment.created",
          data: {
            url: "https://github.com/fankaidev/grovie/issues/37#issuecomment-1",
          },
        },
        {
          timestamp: "2026-05-23T10:01:00.000Z",
          type: "run.failed",
          data: {
            exitCode: 1,
          },
        },
      ],
    });

    const list = runCli(["runs", "list"], { cwd, localState });

    expect(list.stdout).toContain("Status: failed");
    expect(list.stdout).toContain("Agent: coder@fankai-mac");
    expect(list.stdout).toContain("Runtime: codex");
    expect(list.stdout).toContain("Started: 2026-05-23T10:00:00.000Z");
    expect(list.stdout).toContain("Ended: 2026-05-23T10:01:00.000Z");

    const detail = runCli(["runs", "show", "failed-run"], { cwd, localState });

    expect(detail.exitCode).toBe(0);
    expect(detail.stdout).toContain("grovie runs show");
    expect(detail.stdout).toContain("Run id: failed-run");
    expect(detail.stdout).toContain("Local branch: grovie/issue-37-attempt");
    expect(detail.stdout).toContain(`Stderr log: ${join(localState.paths.runsDir, "failed-run", "stderr.log")}`);
    expect(detail.stdout).toContain("Result links: https://github.com/fankaidev/grovie/issues/37#issuecomment-1");
    expect(detail.stdout).toContain('run.failed {"exitCode":1}');
  });

  it("[UC-EXECUTION-02-S09] retries a failed run by enqueuing a new daemon request without deleting history", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });
    writeLocalRun(localState.paths.runsDir, "failed-run", {
      metadata: {
        runId: "failed-run",
        repository: "fankaidev/grovie",
        issueNumber: 79,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-79",
      },
      events: [
        {
          timestamp: "2026-05-23T10:00:00.000Z",
          type: "runtime.started",
          data: {
            runtime: "codex",
          },
        },
        {
          timestamp: "2026-05-23T10:01:00.000Z",
          type: "run.failed",
          data: {
            exitCode: 1,
          },
        },
      ],
    });

    const result = runCli(["runs", "retry", "failed-run"], { cwd, localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Retry requested for failed-run.");
    expect(result.stdout).toContain("Issue: fankaidev/grovie#79");
    expect(result.stdout).toContain("Source run: failed-run");
    expect(result.stdout).toContain("reuse the session worktree");
    expect(localState.requests).toEqual([
      expect.objectContaining({
        repository: "fankaidev/grovie",
        issueNumber: 79,
        agentId: "coder@fankai-mac",
        sourceRunId: "failed-run",
        reason: "retry",
      }),
    ]);
  });

  it("[UC-EXECUTION-02-S09] retries a canceled run by enqueuing a new daemon request", () => {
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });
    writeLocalRun(localState.paths.runsDir, "canceled-run", {
      metadata: {
        runId: "canceled-run",
        repository: "fankaidev/grovie",
        issueNumber: 79,
        agentId: "coder@fankai-mac",
      },
      events: [
        {
          timestamp: "2026-05-23T10:01:00.000Z",
          type: "run.canceled",
        },
      ],
    });

    const result = runCli(["runs", "retry", "canceled-run"], { localState });

    expect(result.exitCode).toBe(0);
    expect(localState.requests[0]).toMatchObject({
      sourceRunId: "canceled-run",
      reason: "retry",
    });
  });

  it("[UC-EXECUTION-02-S10] reruns an issue-agent session through the daemon", () => {
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });

    const result = runCli(["runs", "rerun", "fankaidev/grovie#79", "--agent", "coder@fankai-mac"], { localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rerun requested for fankaidev/grovie#79.");
    expect(result.stdout).toContain("reuse the session worktree");
    expect(localState.requests).toEqual([
      expect.objectContaining({
        repository: "fankaidev/grovie",
        issueNumber: 79,
        agentId: "coder@fankai-mac",
        reason: "rerun",
      }),
    ]);
  });

  it("[UC-EXECUTION-02-S11] refuses retry while the same issue-agent execution is active", () => {
    const localState = new FakeLocalState(createTmpDir(), {
      daemonRunning: true,
      lockedAgents: ["coder@fankai-mac"],
    });
    writeLocalRun(localState.paths.runsDir, "failed-run", {
      metadata: {
        runId: "failed-run",
        repository: "fankaidev/grovie",
        issueNumber: 79,
        agentId: "coder@fankai-mac",
      },
      events: [
        {
          timestamp: "2026-05-23T10:01:00.000Z",
          type: "run.failed",
        },
      ],
    });

    expect(runCli(["runs", "retry", "failed-run"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Grovie execution is already active for fankaidev/grovie#79 and coder@fankai-mac.",
    });
    expect(localState.requests).toEqual([]);
  });

  it("requires a run id for runs show", () => {
    expect(runCli(["runs", "show"])).toEqual({
      exitCode: 1,
      stderr: "Missing run id. Usage: grovie runs show <run-id>",
    });
  });

  it("requires an issue reference for run", () => {
    expect(runCli(["run"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 [--agent coder@machine]",
    });
  });

  it("does not treat option values as issue references", () => {
    expect(runCli(["run", "--agent", "codex"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 [--agent coder@machine]",
    });
  });

  it("rejects malformed issue references with extra path segments", () => {
    expect(runCli(["run", "fankaidev/grovie/extra#2"])).toEqual({
      exitCode: 1,
      stderr: "Missing issue reference. Usage: grovie run owner/repo#123 [--agent coder@machine]",
    });
  });

  it("[UC-EXECUTION-01-S01] accepts the issue reference after options without reading cwd repository identity", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });

    const result = await runCliAsync(["run", "--agent", "coder@fankai-mac", "other/repo#2"], {
      cwd,
      localState,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Requested daemon execution for other/repo#2.");
    expect(localState.requests).toEqual([
      expect.objectContaining({
        repository: "other/repo",
        issueNumber: 2,
        agentId: "coder@fankai-mac",
      }),
    ]);
  });

  it("rejects unsupported run agents", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });
    runCli(["init"], { cwd });

    expect(runCli(["run", "fankaidev/grovie#2", "--agent", "claude"], { cwd, localState })).toEqual({
      exitCode: 1,
      stderr: 'Invalid agent id "claude". Expected <agent-slug>@<machine-slug>.',
    });
  });

  it("[UC-EXECUTION-01-S01] requests manual issue execution for an agent id without adding assignment labels", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });
    writeInvalidPolicyConfig(cwd);

    const result = await runCliAsync(["run", "fankaidev/grovie#2", "--agent", "coder@fankai-mac"], {
      cwd,
      localState,
      runtime: {
        name: "codex",
        checkAvailability: fakeRuntime().checkAvailability,
        run: () => {
          throw new Error("sync runtime path was not expected");
        },
        runAsync: () => {
          throw new Error("foreground runtime path was not expected");
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Requested daemon execution for fankaidev/grovie#2.");
    expect(result.stdout).toContain("Agent: coder@fankai-mac");
    expect(localState.requests).toEqual([
      expect.objectContaining({
        repository: "fankaidev/grovie",
        issueNumber: 2,
        agentId: "coder@fankai-mac",
      }),
    ]);
  });

  it("[UC-EXECUTION-01-S02] fails clearly when no daemon is running", async () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());

    expect(await runCliAsync(["run", "fankaidev/grovie#2", "--agent", `coder@${machineId}`], {
      cwd,
      localState: new FakeLocalState(createTmpDir(), { daemonRunning: false }),
    })).toEqual({
      exitCode: 1,
      stderr: `No Grovie daemon is running for machine ${machineId}. Start one with \`grovie daemon\`.`,
    });
  });

  it("[UC-EXECUTION-01-S03] infers the only local assigned agent", async () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const localState = new FakeLocalState(createTmpDir(), { daemonRunning: true });

    const result = await runCliAsync(["run", "fankaidev/grovie#2"], {
      cwd,
      github: fakeGitHubGateway({
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            labels: ["grovie", `agent:coder@${machineId}`],
          },
        }),
      }),
      localState,
    });

    expect(result.exitCode).toBe(0);
    expect(localState.requests[0]).toEqual(expect.objectContaining({
      repository: "fankaidev/grovie",
      issueNumber: 2,
      agentId: `coder@${machineId}`,
    }));
  });

  it("[UC-EXECUTION-01-S04] fails clearly when no local agent is assigned", async () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());

    const result = await runCliAsync(["run", "fankaidev/grovie#2"], {
      cwd,
      github: fakeGitHubGateway({
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            labels: ["grovie", "agent:coder@other-machine"],
          },
        }),
      }),
      localState: new FakeLocalState(createTmpDir(), { daemonRunning: true }),
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: `No local agent assignment found for fankaidev/grovie#2. Pass --agent or add an agent:<name>@${machineId} label.`,
    });
  });

  it("[UC-EXECUTION-01-S05] fails clearly when multiple local agents are assigned", async () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());

    const result = await runCliAsync(["run", "fankaidev/grovie#2"], {
      cwd,
      github: fakeGitHubGateway({
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            labels: ["grovie", `agent:coder@${machineId}`, `agent:reviewer@${machineId}`],
          },
        }),
      }),
      localState: new FakeLocalState(createTmpDir(), { daemonRunning: true }),
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: `Multiple local agent assignments found for fankaidev/grovie#2: coder@${machineId}, reviewer@${machineId}. Pass --agent to choose one.`,
    });
  });

  it("[UC-EXECUTION-01-S06] reports an active local execution lock", async () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const agentId = `coder@${machineId}`;

    expect(await runCliAsync(["run", "fankaidev/grovie#2", "--agent", agentId], {
      cwd,
      localState: new FakeLocalState(createTmpDir(), {
        daemonRunning: true,
        lockedAgents: [agentId],
      }),
    })).toEqual({
      exitCode: 1,
      stderr: `Grovie execution is already active for fankaidev/grovie#2 and ${agentId}.`,
    });
  });

  it("[UC-WORKER-01-S05] runs one daemon polling cycle from global watched repositories and records default agent metadata", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeInvalidPolicyConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    expect(
      await runCliAsync(["daemon", "--label", "grovie", "--once"], {
        cwd,
        localState,
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
    expect(localState.registeredAgents).toEqual([
      expect.objectContaining({
        agentId: expect.stringMatching(/^default@.+/),
        runtime: "codex",
        envKeys: ["OPENAI_API_KEY"],
      }),
    ]);
  });

  it("[UC-WORKER-05-S01] [UC-WORKER-05-S03] lists global watched assigned issues in daemon pick order", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    writeInvalidPolicyConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    const result = runCli(["queue", "list"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: (repository, label) => {
          expect(repository).toBe("fankaidev/grovie");
          expect(label).toBe("grovie");

          return {
            ok: true,
            value: [
              {
                reference: fakeReference(8),
                title: "Normal priority",
                labels: ["grovie", `agent:coder@${machineId}`, "priority:p2"],
              },
              {
                reference: fakeReference(9),
                title: "Highest priority",
                labels: ["grovie", `agent:coder@${machineId}`, "priority:p0"],
              },
            ],
          };
        },
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: reference.number === 9 ? "Highest priority" : "Normal priority",
            labels: reference.number === 9
              ? ["grovie", `agent:coder@${machineId}`, "priority:p0"]
              : ["grovie", `agent:coder@${machineId}`, "priority:p2"],
          },
        }),
        readRelatedPullRequests: () => ({
          ok: true,
          value: [],
        }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("grovie queue list");
    expect(result.stdout).toContain("fankaidev/grovie label=grovie");
    expect(result.stdout).toContain(`#1 fankaidev/grovie#9 agent=coder@${machineId} priority=p0`);
    expect(result.stdout).toContain(`#2 fankaidev/grovie#8 agent=coder@${machineId} priority=p2`);
    expect(result.stdout?.indexOf("fankaidev/grovie#9")).toBeLessThan(result.stdout?.indexOf("fankaidev/grovie#8") ?? 0);
  });

  it("[UC-WORKER-05-S02] inspects an explicit repository without global watched repositories", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());

    const result = runCli(["queue", "list", "--repo", "fankaidev/other"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: (repository, label) => {
          expect(repository).toBe("fankaidev/other");
          expect(label).toBe("grovie");

          return {
            ok: true,
            value: [
              {
                reference: {
                  owner: "fankaidev",
                  repo: "other",
                  number: 3,
                },
                title: "Other repo issue",
                labels: ["grovie", `agent:coder@${machineId}`],
              },
            ],
          };
        },
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            labels: ["grovie", `agent:coder@${machineId}`],
          },
        }),
        readRelatedPullRequests: () => ({
          ok: true,
          value: [],
        }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fankaidev/other label=grovie");
    expect(result.stdout).toContain(`#1 fankaidev/other#3 agent=coder@${machineId}`);
  });

  it("[UC-WORKER-05-S04] lists skipped assigned issues with clear reasons", () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const lockedAgent = `locked@${machineId}`;
    const localState = new FakeLocalState(createTmpDir(), { lockedAgents: [lockedAgent] });

    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(2),
              title: "Other machine",
              labels: ["grovie", "agent:coder@other-machine"],
            },
            {
              reference: fakeReference(30),
              title: "Handled",
              labels: ["grovie", `agent:coder@${machineId}`],
            },
            {
              reference: fakeReference(4),
              title: "Locked",
              labels: ["grovie", `agent:${lockedAgent}`],
            },
            {
              reference: fakeReference(5),
              title: "Canceled",
              labels: ["grovie", `agent:cancel@${machineId}`, "grovie:cancel"],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: reference.number === 2
              ? "Other machine"
              : reference.number === 30
                ? "Handled"
                : reference.number === 4
                  ? "Locked"
                  : "Canceled",
            labels: reference.number === 2
              ? ["grovie", "agent:coder@other-machine"]
              : reference.number === 30
                ? ["grovie", `agent:coder@${machineId}`]
                : reference.number === 4
                  ? ["grovie", `agent:${lockedAgent}`]
                  : ["grovie", `agent:cancel@${machineId}`, "grovie:cancel"],
            updatedAt: "2026-05-22T00:00:00.000Z",
          },
        }),
        readRelatedPullRequests: () => ({
          ok: true,
          value: [],
        }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("skip fankaidev/grovie#2 agent=coder@other-machine");
    expect(result.stdout).toContain("reason=assigned to another machine");
    expect(result.stdout).toContain("skip fankaidev/grovie#30");
    expect(result.stdout).toContain("reason=no unhandled activity");
    expect(result.stdout).toContain("skip fankaidev/grovie#4");
    expect(result.stdout).toContain("reason=active local execution lock");
    expect(result.stdout).toContain("skip fankaidev/grovie#5");
    expect(result.stdout).toContain("reason=canceled");
  });

  it("[UC-WORKER-05-S04] does not read related pull requests for cheap skipped candidates", () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const lockedAgent = `locked@${machineId}`;
    const localState = new FakeLocalState(createTmpDir(), { lockedAgents: [lockedAgent] });
    const relatedReads: number[] = [];

    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(4),
              title: "Locked",
              labels: ["grovie", `agent:${lockedAgent}`, "priority:p0"],
            },
            {
              reference: fakeReference(8),
              title: "Runnable",
              labels: ["grovie", `agent:coder@${machineId}`, "priority:p1"],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: reference.number === 4 ? "Locked" : "Runnable",
            labels: reference.number === 4
              ? ["grovie", `agent:${lockedAgent}`, "priority:p0"]
              : ["grovie", `agent:coder@${machineId}`, "priority:p1"],
          },
        }),
        readRelatedPullRequests: (reference) => {
          relatedReads.push(reference.number);

          if (reference.number === 4) {
            throw new Error("locked candidate related PR lookup was not expected");
          }

          return {
            ok: true,
            value: [],
          };
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`#1 fankaidev/grovie#8 agent=coder@${machineId}`);
    expect(result.stdout).toContain("skip fankaidev/grovie#4");
    expect(relatedReads).toEqual([8]);
  });

  it("[UC-WORKER-05-S05] queue inspection does not mutate GitHub state or enqueue runs", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());

    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [],
        }),
        createIssueComment: () => {
          throw new Error("queue list must not create comments");
        },
        addLabels: () => {
          throw new Error("queue list must not add labels");
        },
      }),
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        "grovie queue list",
        "",
        "No assigned issues found.",
      ].join("\n"),
    });
    expect(localState.requests).toEqual([]);
  });

  it("[UC-WORKER-05-S06] prints queue inspection as JSON", () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie", "--json"], {
      cwd,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(8),
              title: "JSON issue",
              labels: ["grovie", `agent:coder@${machineId}`],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: "JSON issue",
            labels: ["grovie", `agent:coder@${machineId}`],
          },
        }),
        readRelatedPullRequests: () => ({
          ok: true,
          value: [],
        }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual([
      expect.objectContaining({
        repository: "fankaidev/grovie",
        candidates: [
          expect.objectContaining({
            status: "runnable",
            pickOrder: 1,
            agentId: `coder@${machineId}`,
          }),
        ],
      }),
    ]);
  });

  it("[UC-WORKER-03-S01] assigns an issue to an agent label", () => {
    const addedLabels: Array<{ reference: IssueReference; labels: string[] }> = [];

    expect(
      runCli(["issue", "assign", "fankaidev/grovie#123", "coder@fankai-mac"], {
        github: fakeGitHubGateway({
          addLabels: (reference, labels) => {
            addedLabels.push({ reference, labels });
            return {
              ok: true,
              value: undefined,
            };
          },
        }),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie issue assign",
        "",
        "Added agent:coder@fankai-mac to fankaidev/grovie#123.",
      ].join("\n"),
    });
    expect(addedLabels).toEqual([
      {
        reference: {
          owner: "fankaidev",
          repo: "grovie",
          number: 123,
        },
        labels: ["agent:coder@fankai-mac"],
      },
    ]);
  });

  it("[UC-WORKER-03-S02] unassigns only the matching agent label", () => {
    const removedLabels: Array<{ reference: IssueReference; label: string }> = [];

    expect(
      runCli(["issue", "unassign", "fankaidev/grovie#123", "coder@fankai-mac"], {
        github: fakeGitHubGateway({
          removeLabel: (reference, label) => {
            removedLabels.push({ reference, label });
            return {
              ok: true,
              value: undefined,
            };
          },
        }),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie issue unassign",
        "",
        "Removed agent:coder@fankai-mac from fankaidev/grovie#123.",
      ].join("\n"),
    });
    expect(removedLabels).toEqual([
      {
        reference: {
          owner: "fankaidev",
          repo: "grovie",
          number: 123,
        },
        label: "agent:coder@fankai-mac",
      },
    ]);
  });

  it("uses built-in queue defaults for global daemon without reading cwd policy config", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeInvalidPolicyConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    expect(
      await runCliAsync(["daemon", "--once"], {
        cwd,
        localState,
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

  it("[UC-WORKER-06-S01] runs the daemon foreground subcommand with built-in defaults", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeInvalidPolicyConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    expect(
      await runCliAsync(["daemon", "run", "--once"], {
        cwd,
        localState,
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

  it("[UC-WORKER-06-S02] starts a detached background daemon and reports local state", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const daemonLifecycle = fakeDaemonLifecycle({
      start: ({ root, args }) => {
        expect(root).toBe(localState.paths.root);
        expect(args).toEqual(["start", "--repo", "fankaidev/grovie"]);

        return {
          ok: true,
          state: fakeDaemonState(localState.paths.root, 1234),
        };
      },
    });

    expect(runCli(["daemon", "start", "--repo", "fankaidev/grovie"], { cwd, localState, daemonLifecycle })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie daemon start",
        "",
        "Started Grovie daemon pid 1234.",
        `State: ${localState.paths.root}/daemon/daemon.json`,
        `Stdout log: ${localState.paths.root}/daemon/stdout.log`,
        `Stderr log: ${localState.paths.root}/daemon/stderr.log`,
      ].join("\n"),
    });
  });

  it("[UC-WORKER-06-S02] refuses to start another live background daemon", () => {
    const localState = new FakeLocalState(createTmpDir());
    const daemonLifecycle = fakeDaemonLifecycle({
      start: () => ({
        ok: false,
        message: "Grovie daemon already appears to be running with pid 1234.",
      }),
    });

    expect(runCli(["daemon", "start"], { localState, daemonLifecycle })).toEqual({
      exitCode: 1,
      stderr: "Grovie daemon already appears to be running with pid 1234.",
    });
  });

  it("[UC-WORKER-06-S03] stops the recorded background daemon", () => {
    const localState = new FakeLocalState(createTmpDir());
    const daemonLifecycle = fakeDaemonLifecycle({
      stop: ({ root }) => {
        expect(root).toBe(localState.paths.root);

        return {
          ok: true,
          message: "Stopped Grovie daemon pid 1234.",
        };
      },
    });

    expect(runCli(["daemon", "stop"], { localState, daemonLifecycle })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie daemon stop",
        "",
        "Stopped Grovie daemon pid 1234.",
      ].join("\n"),
    });
  });

  it("[UC-WORKER-06-S04] reports background daemon status", () => {
    const localState = new FakeLocalState(createTmpDir());
    const daemonLifecycle = fakeDaemonLifecycle({
      status: () => ({
        status: "running",
        state: fakeDaemonState(localState.paths.root, 1234),
      }),
    });

    const result = runCli(["daemon", "status"], { localState, daemonLifecycle });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status: running");
    expect(result.stdout).toContain("Pid: 1234");
    expect(result.stdout).toContain(`Stdout log: ${localState.paths.root}/daemon/stdout.log`);
  });

  it("[UC-WORKER-06-S05] prints recent daemon logs from local daemon state", () => {
    const localState = new FakeLocalState(createTmpDir());
    writeDaemonLogs(localState.paths.root, {
      stdout: "stdout old\nstdout new\n",
      stderr: "stderr old\nstderr new\n",
    });

    expect(runCli(["daemon", "logs", "--lines", "1"], { localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie daemon logs",
        "",
        "Stream: combined",
        `== stdout (${localState.paths.root}/daemon/stdout.log) ==`,
        "stdout new",
        `== stderr (${localState.paths.root}/daemon/stderr.log) ==`,
        "stderr new",
      ].join("\n"),
    });
  });

  it("[UC-WORKER-06-S06] selects a daemon log stream through the CLI", () => {
    const localState = new FakeLocalState(createTmpDir());
    writeDaemonLogs(localState.paths.root, {
      stdout: "daemon stdout\n",
      stderr: "daemon stderr\n",
    });

    const result = runCli(["daemon", "logs", "--stream", "stderr"], { localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Stream: stderr");
    expect(result.stdout).toContain("daemon stderr");
    expect(result.stdout).not.toContain("daemon stdout");
  });

  it("[UC-WORKER-06-S07] reports missing daemon logs through the CLI", () => {
    const localState = new FakeLocalState(createTmpDir());

    expect(runCli(["daemon", "logs"], { localState })).toEqual({
      exitCode: 1,
      stderr: `Daemon logs are not available because ${localState.paths.root}/daemon does not exist. Run \`grovie daemon start\` first.`,
    });
  });

  it("runs an explicit daemon repository without reading the current checkout repository", async () => {
    const cwd = createTmpDir();
    writeInvalidPolicyConfig(cwd);

    expect(
      await runCliAsync(["daemon", "--repo", "fankaidev/other", "--label", "ready", "--once"], {
        cwd,
        github: fakeGitHubGateway({
          listOpenIssues: (repository, label) => {
            expect(repository).toBe("fankaidev/other");
            expect(label).toBe("ready");

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
        "No queued issues found for fankaidev/other with label ready.",
      ].join("\n"),
    });
  });

  it("manages watched repositories in the global config", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);

    expect(runCli(["watch", "add", "fankaidev/grovie", "--label", "ready"], { cwd, localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie watch add",
        "",
        "Added fankaidev/grovie.",
        `Config: ${join(globalRoot, "config.yml")}`,
      ].join("\n"),
    });

    expect(runCli(["watch", "list"], { cwd, localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie watch list",
        "",
        `Config: ${join(globalRoot, "config.yml")}`,
        "- fankaidev/grovie label=ready",
      ].join("\n"),
    });

    expect(runCli(["watch", "remove", "fankaidev/grovie"], { cwd, localState }).stdout).toContain("Removed fankaidev/grovie.");
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeInvalidPolicyConfig(cwd: string): void {
  writeFileSync(join(cwd, ".grovie.yml"), "version: 1\nunsupported: true\n", "utf8");
}

function writeLocalRun(
  runsDir: string,
  runId: string,
  input: {
    metadata: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  },
): void {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), input.events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
  writeFileSync(join(runDir, "stdout.log"), "", "utf8");
  writeFileSync(join(runDir, "stderr.log"), "", "utf8");
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

function fakeDaemonLifecycle(overrides: Partial<DaemonLifecycle> = {}): DaemonLifecycle {
  return {
    start: () => ({
      ok: false,
      message: "daemon start was not expected",
    }),
    stop: () => ({
      ok: false,
      message: "daemon stop was not expected",
    }),
    status: () => ({
      status: "stopped",
      daemonDir: "/tmp/grovie/daemon",
    }),
    ...overrides,
  };
}

function fakeDaemonState(root: string, pid: number): Extract<DaemonLifecycleStatus, { status: "running" | "stale" }>["state"] {
  return {
    pid,
    command: [process.execPath, "/project/dist/cli.js", "daemon", "run"],
    startedAt: "2026-05-23T00:00:00.000Z",
    stdoutPath: `${root}/daemon/stdout.log`,
    stderrPath: `${root}/daemon/stderr.log`,
    statePath: `${root}/daemon/daemon.json`,
    token: "daemon-token",
  };
}

function writeDaemonLogs(root: string, input: { stdout: string; stderr: string }): void {
  const daemonDir = join(root, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(daemonDir, "stdout.log"), input.stdout, "utf8");
  writeFileSync(join(daemonDir, "stderr.log"), input.stderr, "utf8");
}

class FakeLocalState implements RunLocalState {
  readonly paths: LocalStatePaths;
  readonly registeredAgents: AgentMetadata[] = [];
  readonly requests: RunRequest[] = [];
  readonly run: PreparedRun = {
    sessionId: "fankaidev-grovie-issue-2-codex",
    runId: "fankaidev-grovie-issue-2",
    agentId: "codex",
    branchName: "grovie/issue-2",
    sessionDir: "/tmp/grovie/sessions/fankaidev-grovie-issue-2-codex",
    repositoryCachePath: "/tmp/grovie/repos/fankaidev-grovie.git",
    worktreePath: "/tmp/grovie/worktrees/fankaidev-grovie-issue-2",
    runDir: "/tmp/grovie/runs/fankaidev-grovie-issue-2",
    taskPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/task.json",
    promptPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/prompt.md",
    eventsPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/events.jsonl",
    stdoutPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/stdout.log",
    stderrPath: "/tmp/grovie/runs/fankaidev-grovie-issue-2/stderr.log",
  };

  constructor(
    root = "/tmp/grovie",
    private readonly options: { daemonRunning?: boolean; lockedAgents?: string[] } = {},
  ) {
    this.paths = {
      root,
      reposDir: `${root}/repos`,
      worktreesDir: `${root}/worktrees`,
      runsDir: `${root}/runs`,
      agentsDir: `${root}/agents`,
      locksDir: `${root}/locks`,
      requestsDir: `${root}/requests`,
      sessionsDir: `${root}/sessions`,
    };
  }

  getPaths(): LocalStatePaths {
    return this.paths;
  }

  prepareRun(): PreparedRun {
    return this.run;
  }

  appendEvent(): void {}

  registerAgent(metadata: AgentMetadata): void {
    this.registeredAgents.push(metadata);
  }

  isDaemonRunning(): boolean {
    return this.options.daemonRunning === true;
  }

  hasExecutionLock(input: { agentId: string }): boolean {
    return this.options.lockedAgents?.includes(input.agentId) === true;
  }

  readHandledCursor(input: { repository: string; issueNumber: number; agentId: string }): HandledCursor | undefined {
    if (input.issueNumber === 30 && input.agentId.startsWith("coder@")) {
      return {
        repository: input.repository,
        issueNumber: input.issueNumber,
        agentId: input.agentId,
        handledThrough: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      };
    }

    return undefined;
  }

  enqueueRunRequest(input: { repository: string; issueNumber: number; agentId: string; sourceRunId?: string; reason?: RunRequest["reason"] }): RunRequest {
    const request = {
      id: `request-${this.requests.length + 1}`,
      repository: input.repository,
      issueNumber: input.issueNumber,
      agentId: input.agentId,
      createdAt: "2026-05-23T00:00:00.000Z",
      path: `${this.paths.requestsDir}/request-${this.requests.length + 1}.json`,
      sourceRunId: input.sourceRunId,
      reason: input.reason,
    };
    this.requests.push(request);
    return request;
  }
}

function fakeIssue(reference: IssueReference): GitHubIssue {
  return {
    reference,
    title: "Stream runtime output",
    body: "Make runtime logs visible while Codex runs.",
    state: "open",
    updatedAt: "2026-05-22T00:00:00Z",
    labels: ["mvp", "type:task"],
    comments: [],
    defaultBranch: "main",
  };
}

function fakeReference(number: number): IssueReference {
  return {
    owner: "fankaidev",
    repo: "grovie",
    number,
  };
}

function addIssueComment(comments: GitHubIssue["comments"], body: string): CreatedComment {
  const id = comments.length + 1;
  const timestamp = new Date().toISOString();

  comments.push({
    id,
    body,
    author: "fankaidev",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    id,
    body,
    url: `https://github.com/fankaidev/grovie/issues/2#issuecomment-${id}`,
  };
}

function fakeExecution(run: PreparedRun, exitCode: number) {
  return {
    runtime: "codex" as const,
    command: ["codex", "exec"],
    startedAt: "2026-05-23T00:00:00Z",
    endedAt: "2026-05-23T00:00:01Z",
    exitCode,
    promptPath: run.promptPath,
    taskPath: run.taskPath,
    worktreePromptPath: `${run.worktreePath}/.grovie/prompt.md`,
    worktreeTaskPath: `${run.worktreePath}/.grovie/task.json`,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
  };
}
