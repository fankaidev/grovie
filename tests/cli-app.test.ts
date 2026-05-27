import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commands, renderHelp, runCli, runCliAsync } from "../src/cli-app.js";
import { saveGlobalConfig } from "../src/config.js";
import type { DaemonLifecycle, DaemonLifecycleStatus } from "../src/daemon-lifecycle.js";
import { resolveMachineId } from "../src/identity.js";
import { GROVIE_VERSION } from "../src/version.js";
import type { CreatedComment, GitHubGateway, GitHubIssue, IssueReference } from "../src/github.js";
import type { HandledCursor, LocalStatePaths, PreparedRun } from "../src/local-state.js";
import type { RunLocalState } from "../src/run.js";
import type { AgentRunInput, AgentRuntime, RuntimeAvailability, RuntimeName } from "../src/runtime.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI command registration", () => {
  it("registers issue assignment, queue, and daemon commands", () => {
    expect(commands.map((command) => command.name)).toEqual(["init", "doctor", "status", "runs", "issue", "queue", "daemon", "state", "watch"]);
  });

  it("renders help with queue and daemon commands", () => {
    const help = renderHelp();

    expect(help).toContain("grovie <command>");
    expect(help).toContain("-v, --version");
    expect(help).toContain("init");
    expect(help).toContain("doctor");
    expect(help).toContain("status");
    expect(help).toContain("runs");
    expect(help).toContain("queue");
    expect(help).toContain("daemon");
    expect(help).toContain("state");
    expect(help).not.toContain("admin");
    expect(help).toContain("watch");
  });

  it("accepts pnpm script argument separators", () => {
    expect(runCli(["--", "--help"])).toEqual({
      exitCode: 0,
      stdout: renderHelp(),
    });
  });

  it("[UC-SESSION-01-S10] renders command-specific usage with supported subcommand options", () => {
    expect(runCli(["queue", "--help"]).stdout).toContain("grovie queue list [--repo owner/repo] [--json] [--fast|--no-pr-context] [--timeout 15s]");

    const runsHelp = runCli(["runs", "--help"]).stdout;
    expect(runsHelp).toContain("grovie runs list [--limit 20] [--status status] [--repo owner/repo] [--issue owner/repo#123|123] [--agent agent@machine]");
    expect(runsHelp).toContain("grovie runs show <run-id>");
    expect(runsHelp).toContain("grovie runs cleanup [--dry-run] [--logs] [--older-than 30m|12h|7d]");
    expect(runsHelp).not.toContain("grovie runs retry");
    expect(runsHelp).not.toContain("grovie runs rerun");

    const daemonHelp = runCli(["daemon", "--help"]).stdout;
    expect(daemonHelp).toContain("grovie daemon [--repo owner/repo] [--label grovie] [--once]");
    expect(daemonHelp).not.toContain("grovie daemon [run]");
    expect(daemonHelp).toContain("grovie daemon stop [--force]");
    expect(daemonHelp).toContain("grovie daemon logs [--stream combined|stdout|stderr] [--lines 100] [--follow]");
    expect(daemonHelp).toContain("grovie daemon service <install|uninstall|path> [--platform launchd|systemd]");

    const watchHelp = runCli(["watch", "--help"]).stdout;
    expect(watchHelp).toContain("grovie watch add owner/repo [--label grovie]");
    expect(watchHelp).toContain("grovie watch list");
    expect(watchHelp).toContain("grovie watch remove owner/repo");
  });

  it("[UC-DAEMON-04-S17] rejects unknown, duplicate, and extra CLI arguments consistently", async () => {
    const localState = new FakeLocalState(createTmpDir());

    expect(runCli(["init", "--bogus"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unknown option: --bogus",
    });
    expect(runCli(["status", "--bogus"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unknown option: --bogus",
    });
    expect(runCli(["runs", "list", "--bogus"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unknown option: --bogus",
    });
    expect(runCli(["runs", "show", "run-1", "extra"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unexpected argument: extra",
    });
    expect(runCli(["runs", "cleanup", "--older-than", "1d", "--older-than", "2d"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Duplicate option: --older-than",
    });
    expect(runCli(["daemon", "status", "--bogus"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unknown option: --bogus",
    });
    expect(runCli(["daemon", "logs", "--lines"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Missing value for --lines.",
    });
    expect(runCli(["queue", "list", "--json", "--json"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Duplicate option: --json",
    });
    expect(runCli(["queue", "list", "--timeout", "soon"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Invalid --timeout value. Use a positive duration like 500ms, 15s, or 2m.",
    });
    expect(runCli(["watch", "list", "--bogus"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unknown option: --bogus",
    });
    expect(runCli(["watch", "add", "fankaidev/grovie", "extra"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unexpected argument: extra",
    });
    expect(runCli(["issue", "assign", "fankaidev/grovie#1", "coder@machine", "--bogus"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Unknown option: --bogus",
    });
    expect(runCli(["state", "init", "--repo"], { localState })).toEqual({
      exitCode: 1,
      stderr: "Missing value for --repo.",
    });
    expect(runCli(["admin", "serve"], { localState }).stderr).toContain("Unknown command: admin");
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

  it("writes the default global Grovie config", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);

    expect(runCli(["init"], { cwd, localState })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie init",
        "",
        `Wrote global config: ${join(globalRoot, "config.yml")}`,
        "Run `grovie doctor` to validate it.",
      ].join("\n"),
    });

    expect(readFileSync(join(globalRoot, "config.yml"), "utf8")).toContain("watchedRepositories: []");
  });

  it("[UC-DAEMON-01-S06] reports invalid global config fields through doctor", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    writeFileSync(join(globalRoot, "config.yml"), "version: 1\nwatchedRepositories: []\nadminConsole:\n  enabled: true\n  host: ''\n", "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("adminConsole.host: must not be empty"),
    });
  });

  it("[UC-DAEMON-01-S06] rejects unknown global config fields through doctor", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    writeFileSync(join(globalRoot, "config.yml"), "version: 1\nwatchedRepositories: []\nunsupported: true\n", "utf8");

    expect(runCli(["doctor"], { cwd, github: fakeGitHubGateway(), runtime: fakeRuntime(), localState })).toEqual({
      exitCode: 1,
      stderr: expect.stringContaining("Unrecognized key: \"unsupported\""),
    });
  });

  it("[UC-AGENT-01-S04] reports explicitly configured local agents through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);

    expect(runCli(["doctor"], {
      cwd,
      github: fakeGitHubGateway(),
      runtime: fakeRuntime(),
      runtimeAvailabilityChecker: fakeRuntimeAvailability,
      localState,
    })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "Mode: fast local check. Agent execution is not verified; run `grovie doctor --verify-agents` for deep checks.",
        "",
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Machine id: ${machineId}`,
        "Runtimes:",
        "- codex command=codex: CLI available (codex-cli 0.133.0)",
        "- claude-code command=claude: CLI available (2.1.142 (Claude Code))",
        "- pi command=pi: pi command not found",
        "Configured agents:",
        `- coder@${machineId} (codex, command=codex): CLI available (codex-cli 0.133.0)`,
        "GitHub: authenticated as fankaidev.",
      ].join("\n"),
    });
  });

  it("[UC-AGENT-01-S04] [UC-AGENT-01-S06] reports unavailable configured agents through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());
    saveGlobalConfig(globalRoot, {
      version: 1,
      agents: [
        { name: "codex", runtime: "codex", envKeys: [] },
        { name: "pi", runtime: "pi", envKeys: [] },
      ],
      watchedRepositories: [],
      adminConsole: { enabled: false },
    });

    expect(runCli(["doctor"], {
      cwd,
      github: fakeGitHubGateway(),
      localState,
      runtimeAvailabilityChecker: fakeRuntimeAvailability,
    })).toEqual({
      exitCode: 1,
      stdout: [
        "grovie doctor",
        "Mode: fast local check. Agent execution is not verified; run `grovie doctor --verify-agents` for deep checks.",
        "",
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Machine id: ${machineId}`,
        "Runtimes:",
        "- codex command=codex: CLI available (codex-cli 0.133.0)",
        "- claude-code command=claude: CLI available (2.1.142 (Claude Code))",
        "- pi command=pi: pi command not found",
        "Configured agents:",
        `- codex@${machineId} (codex, command=codex): CLI available (codex-cli 0.133.0)`,
        `- pi@${machineId} (pi, command=pi): pi command not found`,
        "GitHub: authenticated as fankaidev.",
      ].join("\n"),
      stderr: [
        "Unavailable configured agents:",
        `- pi@${machineId}: pi command not found`,
      ].join("\n"),
    });
  });

  it("[UC-AGENT-01-S07] verifies configured agent execution through doctor on request", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());
    saveGlobalConfig(globalRoot, {
      version: 1,
      agents: [
        { name: "coder", runtime: "codex", model: "gpt-5", envKeys: ["OPENAI_API_KEY"] },
      ],
      watchedRepositories: [],
      adminConsole: { enabled: false },
    });
    const verifiedAgents: string[] = [];

    expect(runCli(["doctor", "--verify-agents"], {
      cwd,
      github: fakeGitHubGateway(),
      localState,
      runtimeAvailabilityChecker: fakeRuntimeAvailability,
      agentVerifier: (agent) => {
        verifiedAgents.push(agent.agentId);
        return {
          agent,
          ok: true,
          command: ["codex", "exec", "--model", agent.model ?? "", "-"],
          stdout: "GROVIE_AGENT_OK\n",
          stderr: "",
          message: "verified",
        };
      },
    })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "Mode: deep configured-agent verification. This may call remote model providers and consume credits.",
        "",
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Machine id: ${machineId}`,
        "Runtimes:",
        "- codex command=codex: CLI available (codex-cli 0.133.0)",
        "- claude-code command=claude: CLI available (2.1.142 (Claude Code))",
        "- pi command=pi: pi command not found",
        "Configured agents:",
        `- coder@${machineId} (codex, command=codex): CLI available (codex-cli 0.133.0)`,
        "GitHub: authenticated as fankaidev.",
        "Agent execution verification:",
        "This check runs real agent invocations and may use network access or provider credits.",
        `- coder@${machineId} (codex, model=gpt-5): verified`,
        "  command: \"codex\" \"exec\" \"--model\" \"gpt-5\" \"-\"",
        "  envKeys: OPENAI_API_KEY",
      ].join("\n"),
    });
    expect(verifiedAgents).toEqual([`coder@${machineId}`]);
  });

  it("[UC-AGENT-01-S07] reports all configured agent verification failures without secret values", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "secret-value";
    saveGlobalConfig(globalRoot, {
      version: 1,
      agents: [
        { name: "coder", runtime: "codex", envKeys: ["OPENAI_API_KEY"] },
        { name: "reviewer", runtime: "codex", envKeys: ["DEEPSEEK_API_KEY"] },
      ],
      watchedRepositories: [],
      adminConsole: { enabled: false },
    });

    const result = runCli(["doctor", "--verify-agents"], {
      cwd,
      github: fakeGitHubGateway(),
      localState,
      runtimeAvailabilityChecker: fakeRuntimeAvailability,
      agentVerifier: (agent) => ({
        agent,
        ok: agent.name === "coder",
        command: ["codex", "exec", "-"],
        stdout: agent.name === "coder" ? "GROVIE_AGENT_OK\n" : "",
        stderr: agent.name === "coder" ? "" : "missing API key",
        message: agent.name === "coder"
          ? "verified"
          : "provider error: OPENAI_API_KEY=secret-value Authorization: Bearer sk-test-secret-token",
      }),
    });
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`- coder@${machineId} (codex): verified`);
    expect(result.stdout).toContain(`- reviewer@${machineId} (codex): failed: provider error: OPENAI_API_KEY=[REDACTED] Authorization: Bearer [REDACTED]`);
    expect(result.stdout).toContain("  envKeys: DEEPSEEK_API_KEY");
    expect(result.stdout).not.toContain("secret-value");
    expect(result.stdout).not.toContain("sk-test-secret-token");
    expect(result.stderr).toBe([
      "Failed configured agent verifications:",
      `- reviewer@${machineId}: provider error: OPENAI_API_KEY=[REDACTED] Authorization: Bearer [REDACTED]`,
    ].join("\n"));
  });

  it("[UC-AGENT-01-S07] verifies available agents when another configured runtime is unavailable", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });

    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const machineId = resolveMachineId(hostname());
    saveGlobalConfig(globalRoot, {
      version: 1,
      agents: [
        { name: "coder", runtime: "codex", envKeys: [] },
        { name: "pi", runtime: "pi", envKeys: [] },
      ],
      watchedRepositories: [],
      adminConsole: { enabled: false },
    });
    const verifiedAgents: string[] = [];

    const result = runCli(["doctor", "--verify-agents"], {
      cwd,
      github: fakeGitHubGateway(),
      localState,
      runtimeAvailabilityChecker: fakeRuntimeAvailability,
      agentVerifier: (agent) => {
        verifiedAgents.push(agent.agentId);
        return {
          agent,
          ok: true,
          command: ["codex", "exec", "-"],
          stdout: "GROVIE_AGENT_OK\n",
          stderr: "",
          message: "verified",
        };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`- coder@${machineId} (codex): verified`);
    expect(result.stdout).toContain(`- pi@${machineId} (pi): failed: runtime unavailable: pi command not found`);
    expect(result.stderr).toBe([
      "Failed configured agent verifications:",
      `- pi@${machineId}: runtime unavailable: pi command not found`,
    ].join("\n"));
    expect(verifiedAgents).toEqual([`coder@${machineId}`]);
  });

  it("[UC-STATE-REPO-01-S01] configures a private default state repository through state init", () => {
    const root = createTmpDir();
    const created: Array<{ repository: string; private: boolean }> = [];

    const result = runCli(["state", "init", "--owner", "fankaidev"], {
      localState: new FakeLocalState(root),
      github: fakeGitHubGateway({
        readRepository: () => ({
          ok: false,
          error: {
            code: "gh_failed",
            message: "not found",
          },
        }),
        createRepository: (request) => {
          created.push(request);
          return {
            ok: true,
            value: {
              repository: request.repository,
              private: request.private,
              url: `https://github.com/${request.repository}`,
            },
          };
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created private state repository fankaidev/grovie-state.");
    expect(created).toEqual([
      {
        repository: "fankaidev/grovie-state",
        private: true,
      },
    ]);
    expect(readFileSync(join(root, "config.yml"), "utf8")).toContain("stateRepo:");
  });

  it("[UC-AGENT-01-S04] [UC-RUN-02-S02] reports unavailable runtime inventory through doctor", () => {
    const cwd = createTmpDir();
    runCli(["init"], { cwd });
    const globalRoot = createTmpDir();
    const machineId = resolveMachineId(hostname());

    expect(
      runCli(["doctor"], {
        cwd,
        github: fakeGitHubGateway(),
        localState: new FakeLocalState(globalRoot),
        runtimeAvailabilityChecker: (runtime) => runtime === "codex"
          ? {
              runtime,
              command: "codex",
              available: false,
              message: "codex command not found",
            }
          : fakeRuntimeAvailability(runtime),
      }),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "grovie doctor",
        "Mode: fast local check. Agent execution is not verified; run `grovie doctor --verify-agents` for deep checks.",
        "",
        `Global config: ${join(globalRoot, "config.yml")} (0 watched repositories).`,
        `Machine id: ${machineId}`,
        "Runtimes:",
        "- codex command=codex: codex command not found",
        "- claude-code command=claude: CLI available (2.1.142 (Claude Code))",
        "- pi command=pi: pi command not found",
        "Configured agents: none",
        "GitHub: authenticated as fankaidev.",
      ].join("\n"),
    });
  });

  it("[UC-AGENT-01-S06] reports GitHub authentication errors through doctor", () => {
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

  it("[UC-DAEMON-04-S08] shows daemon state, admin console lifecycle, watched repositories, useful paths, active runs, and failures through status", () => {
    const cwd = createTmpDir();
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    saveGlobalConfig(globalRoot, {
      version: 1,
      agents: [],
      watchedRepositories: [{ repository: "fankaidev/grovie" }],
      adminConsole: {
        enabled: true,
        host: "localhost",
        port: 9876,
      },
    });
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
    expect(result.stdout).toContain("Admin console:");
    expect(result.stdout).toContain("Enabled: true");
    expect(result.stdout).toContain("URL: http://localhost:9876");
    expect(result.stdout).toContain("Availability: not expected to be available while the daemon is stopped");
    expect(result.stdout).toContain("Configured agents:");
    expect(result.stdout).toContain("none");
    expect(result.stdout).toContain("- fankaidev/grovie");
    expect(result.stdout).toContain(`Runs: ${localState.paths.runsDir}`);
    expect(result.stdout).toContain("active-run fankaidev/grovie#36 status=running");
  });

  it("[UC-SESSION-01-S07] [UC-SESSION-01-S08] lists and shows local runs through runs subcommands", () => {
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

  it("[UC-SESSION-01-S15] limits and filters local run history through runs list", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());

    for (let index = 1; index <= 22; index += 1) {
      writeLocalRun(localState.paths.runsDir, `bulk-run-${index.toString().padStart(2, "0")}`, {
        metadata: {
          runId: `bulk-run-${index.toString().padStart(2, "0")}`,
          repository: "fankaidev/grovie",
          issueNumber: index,
          agentId: "bulk@fankai-mac",
          branchName: `grovie/issue-${index}`,
        },
        events: [
          {
            timestamp: `2026-05-23T10:${index.toString().padStart(2, "0")}:00.000Z`,
            type: "run.succeeded",
            data: {
              exitCode: 0,
            },
          },
        ],
      });
    }

    writeLocalRun(localState.paths.runsDir, "failed-other", {
      metadata: {
        runId: "failed-other",
        repository: "fankaidev/other",
        issueNumber: 2,
        agentId: "reviewer@fankai-mac",
        branchName: "grovie/issue-2",
      },
      events: [
        {
          timestamp: "2026-05-23T11:00:00.000Z",
          type: "run.failed",
          data: {
            exitCode: 1,
          },
        },
      ],
    });
    writeLocalRun(localState.paths.runsDir, "running-grovie", {
      metadata: {
        runId: "running-grovie",
        repository: "fankaidev/grovie",
        issueNumber: 2,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-2",
      },
      events: [
        {
          timestamp: "2026-05-23T11:01:00.000Z",
          type: "runtime.started",
          data: {
            runtime: "codex",
          },
        },
      ],
    });

    const defaultList = runCli(["runs", "list"], { cwd, localState });

    expect(defaultList.exitCode).toBe(0);
    expect(defaultList.stdout).toContain("running-grovie");
    expect(defaultList.stdout).not.toContain("bulk-run-01");
    expect(defaultList.stdout).not.toContain("bulk-run-02");

    const failedList = runCli(["runs", "list", "--status", "failed"], { cwd, localState });

    expect(failedList.stdout).toContain("failed-other");
    expect(failedList.stdout).not.toContain("running-grovie");

    const focusedList = runCli(["runs", "list", "--repo", "fankaidev/grovie", "--issue", "2", "--agent", "coder@fankai-mac"], { cwd, localState });

    expect(focusedList.stdout).toContain("running-grovie");
    expect(focusedList.stdout).not.toContain("failed-other");

    const issueReferenceList = runCli(["runs", "list", "--issue", "fankaidev/other#2"], { cwd, localState });

    expect(issueReferenceList.stdout).toContain("failed-other");
    expect(issueReferenceList.stdout).not.toContain("running-grovie");

    expect(runCli(["runs", "list", "--status", "done"], { cwd, localState })).toEqual({
      exitCode: 1,
      stderr: "Invalid --status value. Use one of: preparing, prepared, running, interrupting, interrupted, resuming, rejected, succeeded, failed, canceled, stale, unknown.",
    });
  });

  it("[UC-SESSION-02-S08] runs local cleanup in dry-run mode from the CLI", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const worktreePath = join(localState.paths.worktreesDir, "cleanup-session");
    mkdirSync(worktreePath, { recursive: true });
    writeLocalRun(localState.paths.runsDir, "cleanup-run", {
      metadata: {
        runId: "cleanup-run",
        repository: "fankaidev/grovie",
        issueNumber: 37,
        agentId: "coder@fankai-mac",
        branchName: "grovie/issue-37",
        worktreePath,
      },
      events: [
        {
          timestamp: "2026-05-23T10:00:00.000Z",
          type: "run.succeeded",
          data: {
            exitCode: 0,
          },
        },
      ],
    });

    const result = runCli(["runs", "cleanup", "--dry-run"], { cwd, localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("grovie runs cleanup");
    expect(result.stdout).toContain("Would remove worktrees: 1");
    expect(result.stdout).toContain(worktreePath);
    expect(readFileSync(join(localState.paths.runsDir, "cleanup-run", "events.jsonl"), "utf8")).not.toContain("worktree.cleaned");
  });

  it("[UC-RUN-01-S01] [UC-RUN-01-S04] no longer registers the removed run command or writes local request files", () => {
    const globalRoot = createTmpDir();
    const result = runCli(["run", "fankaidev/grovie#2", "--agent", "coder@fankai-mac"], {
      localState: new FakeLocalState(globalRoot),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: run");
    expect(existsSync(join(globalRoot, "requests"))).toBe(false);
  });

  it("[UC-SESSION-01-S09] [UC-SESSION-01-S10] no longer supports request-file retry or rerun subcommands", () => {
    expect(runCli(["runs", "retry", "failed-run"])).toEqual({
      exitCode: 1,
      stderr: "Missing runs subcommand. Usage: grovie runs <list|show|cleanup>",
    });
    expect(runCli(["runs", "rerun", "fankaidev/grovie#79", "--agent", "coder@fankai-mac"])).toEqual({
      exitCode: 1,
      stderr: "Missing runs subcommand. Usage: grovie runs <list|show|cleanup>",
    });
  });

  it("[UC-AGENT-01-S05] runs one daemon polling cycle from global watched repositories with explicit agent config", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeIgnoredRepoLocalConfig(cwd);
    configureLocalAgent(localState);
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
  });

  it("[UC-DAEMON-03-S01] [UC-DAEMON-03-S03] lists global watched assigned issues in daemon pick order", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    writeIgnoredRepoLocalConfig(cwd);
    configureLocalAgent(localState);
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

  it("[UC-DAEMON-02-S17] shows untrusted issue creators as skipped in queue inspection", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);

    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(8),
              title: "External request",
              labels: ["grovie", `agent:coder@${machineId}`],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            author: "external-user",
            title: "External request",
            labels: ["grovie", `agent:coder@${machineId}`],
          },
        }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("- skip fankaidev/grovie#8");
    expect(result.stdout).toContain("reason=untrusted issue creator external-user");
  });

  it("[UC-DAEMON-03-S02] inspects an explicit repository without global watched repositories", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);

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

  it("[UC-DAEMON-03-S04] lists skipped assigned issues with clear reasons", () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const lockedAgent = `locked@${machineId}`;
    const localState = new FakeLocalState(createTmpDir(), { lockedAgents: [lockedAgent] });
    configureLocalAgent(localState, ["coder", "locked", "cancel"]);

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

  it("[UC-DAEMON-03-S04] does not read related pull requests for cheap skipped candidates", () => {
    const cwd = createTmpDir();
    const machineId = resolveMachineId(hostname());
    const lockedAgent = `locked@${machineId}`;
    const localState = new FakeLocalState(createTmpDir(), { lockedAgents: [lockedAgent] });
    configureLocalAgent(localState, ["coder", "locked"]);
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

  it("[UC-DAEMON-03-S05] queue inspection does not mutate GitHub state or enqueue runs", () => {
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
  });

  it("[UC-DAEMON-03-S06] prints queue inspection as JSON", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);
    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie", "--json"], {
      cwd,
      localState,
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

  it("[UC-DAEMON-03-S08] skips related pull request context in fast queue inspection", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);
    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie", "--fast"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(8),
              title: "Fast issue",
              labels: ["grovie", `agent:coder@${machineId}`],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: "Fast issue",
            labels: ["grovie", `agent:coder@${machineId}`],
          },
        }),
        readRelatedPullRequests: () => {
          throw new Error("fast queue inspection should not read related pull requests");
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`#1 fankaidev/grovie#8 agent=coder@${machineId}`);
  });

  it("[UC-DAEMON-03-S08] treats no-pr-context as a fast queue inspection alias", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);
    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie", "--no-pr-context"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(8),
              title: "No PR context issue",
              labels: ["grovie", `agent:coder@${machineId}`],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: "No PR context issue",
            labels: ["grovie", `agent:coder@${machineId}`],
          },
        }),
        readRelatedPullRequests: () => {
          throw new Error("no-pr-context queue inspection should not read related pull requests");
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`#1 fankaidev/grovie#8 agent=coder@${machineId}`);
  });

  it("[UC-DAEMON-03-S07] skips machine-local agent labels that are not configured locally", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    const machineId = resolveMachineId(hostname());
    configureLocalAgent(localState);

    const result = runCli(["queue", "list", "--repo", "fankaidev/grovie"], {
      cwd,
      localState,
      github: fakeGitHubGateway({
        listOpenIssues: () => ({
          ok: true,
          value: [
            {
              reference: fakeReference(99),
              title: "Old default assignment",
              labels: ["grovie", `agent:default@${machineId}`],
            },
          ],
        }),
        readIssue: (reference) => ({
          ok: true,
          value: {
            ...fakeIssue(reference),
            title: "Old default assignment",
            labels: ["grovie", `agent:default@${machineId}`],
          },
        }),
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`skip fankaidev/grovie#99 agent=default@${machineId}`);
    expect(result.stdout).toContain("reason=agent not configured locally");
  });

  it("[UC-AGENT-02-S01] assigns an issue to an agent label", () => {
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

  it("[UC-AGENT-02-S02] unassigns only the matching agent label", () => {
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

  it("[UC-DAEMON-01-S03] uses built-in queue defaults for global daemon without reading cwd policy config", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeIgnoredRepoLocalConfig(cwd);
    configureLocalAgent(localState);
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

  it("[UC-DAEMON-04-S01] runs the daemon foreground command with built-in defaults", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeIgnoredRepoLocalConfig(cwd);
    configureLocalAgent(localState);
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

  it("rejects the removed daemon run alias", async () => {
    expect(await runCliAsync(["daemon", "run", "--once"])).toEqual({
      exitCode: 1,
      stderr: "Unknown daemon subcommand: run. Usage: grovie daemon [--repo owner/repo] [--label grovie] [--once]",
      stdout: undefined,
    });
  });

  it("[UC-DAEMON-01-S07] exits clearly when the daemon has no configured local agents", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeIgnoredRepoLocalConfig(cwd);
    runCli(["watch", "add", "fankaidev/grovie"], { cwd, localState });

    expect(
      await runCliAsync(["daemon", "--once"], {
        cwd,
        localState,
        github: fakeGitHubGateway(),
        runtime: fakeRuntime(),
      }),
    ).toEqual({
      exitCode: 1,
      stderr: "No local agents are configured. Add agents to the global Grovie config before starting the daemon.",
      stdout: undefined,
    });
  });

  it("[UC-DAEMON-04-S02] starts a detached background daemon and reports local state", () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    configureLocalAgent(localState);
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

  it("[UC-DAEMON-01-S07] refuses detached daemon start when no local agents are configured", () => {
    const localState = new FakeLocalState(createTmpDir());
    const daemonLifecycle = fakeDaemonLifecycle({
      start: () => {
        throw new Error("daemon start was not expected");
      },
    });

    expect(runCli(["daemon", "start"], { localState, daemonLifecycle })).toEqual({
      exitCode: 1,
      stderr: "No local agents are configured. Add agents to the global Grovie config before starting the daemon.",
    });
  });

  it("[UC-ADMIN-01-S04] fails detached daemon start clearly when the enabled admin console port is unavailable", async () => {
    const localState = new FakeLocalState(createTmpDir());
    saveGlobalConfig(localState.paths.root, {
      version: 1,
      agents: [
        {
          name: "coder",
          runtime: "codex",
          envKeys: ["OPENAI_API_KEY"],
        },
      ],
      watchedRepositories: [],
      adminConsole: {
        enabled: true,
        host: "localhost",
        port: 9876,
      },
    });

    await expect(
      runCliAsync(["daemon", "start"], {
        localState,
        adminConsolePortCheck: async (config) => {
          expect(config).toEqual({
            enabled: true,
            host: "localhost",
            port: 9876,
          });

          throw new Error("Admin console port 9876 is unavailable on localhost.");
        },
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: "Admin console port 9876 is unavailable on localhost.",
    });
  });

  it("[UC-DAEMON-04-S02] refuses to start another live background daemon", () => {
    const localState = new FakeLocalState(createTmpDir());
    configureLocalAgent(localState);
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

  it("[UC-DAEMON-04-S03] stops the recorded background daemon", () => {
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

  it("[UC-DAEMON-04-S13] passes force stop requests to the daemon lifecycle", () => {
    const localState = new FakeLocalState(createTmpDir());
    const daemonLifecycle = fakeDaemonLifecycle({
      stop: ({ root, force }) => {
        expect(root).toBe(localState.paths.root);
        expect(force).toBe(true);

        return {
          ok: true,
          message: "Stopped Grovie daemon pid 1234.",
        };
      },
    });

    expect(runCli(["daemon", "stop", "--force"], { localState, daemonLifecycle }).exitCode).toBe(0);
  });

  it("[UC-DAEMON-04-S04] reports background daemon status", () => {
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

  it("[UC-DAEMON-04-S05] prints recent daemon logs from local daemon state", () => {
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

  it("[UC-DAEMON-04-S06] selects a daemon log stream through the CLI", () => {
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

  it("[UC-DAEMON-04-S12] reports daemon service paths through the CLI", () => {
    const localState = new FakeLocalState(createTmpDir());

    const result = runCli(["daemon", "service", "path", "--platform", "systemd"], { localState });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("grovie daemon service path");
    expect(result.stdout).toContain("Platform: systemd");
    expect(result.stdout).toContain(".config/systemd/user/grovie.service");
  });

  it("[UC-DAEMON-04-S07] reports missing daemon logs through the CLI", () => {
    const localState = new FakeLocalState(createTmpDir());

    expect(runCli(["daemon", "logs"], { localState })).toEqual({
      exitCode: 1,
      stderr: `Daemon logs are not available because ${localState.paths.root}/daemon does not exist. Run \`grovie daemon start\` first.`,
    });
  });

  it("[UC-DAEMON-04-S01] runs an explicit daemon repository without reading the current checkout repository", async () => {
    const cwd = createTmpDir();
    const localState = new FakeLocalState(createTmpDir());
    writeIgnoredRepoLocalConfig(cwd);
    configureLocalAgent(localState);

    expect(
      await runCliAsync(["daemon", "--repo", "fankaidev/other", "--label", "ready", "--once"], {
        cwd,
        localState,
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

  it("[UC-DAEMON-01-S01] [UC-DAEMON-01-S02] manages watched repositories in the global config", () => {
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
        "Daemon: not running; changes will apply the next time it starts.",
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

    const remove = runCli(["watch", "remove", "fankaidev/grovie"], { cwd, localState });

    expect(remove.stdout).toContain("Removed fankaidev/grovie.");
    expect(remove.stdout).toContain("Daemon: not running; changes will apply the next time it starts.");
  });

  it("[UC-DAEMON-01-S09] warns when watch changes require a running daemon restart", () => {
    const globalRoot = createTmpDir();
    const localState = new FakeLocalState(globalRoot);
    const daemonLifecycle = fakeDaemonLifecycle({
      status: () => ({
        status: "running",
        state: fakeDaemonState(globalRoot, 1234),
      }),
    });

    expect(runCli(["watch", "add", "fankaidev/grovie"], { localState, daemonLifecycle })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie watch add",
        "",
        "Added fankaidev/grovie.",
        `Config: ${join(globalRoot, "config.yml")}`,
        "Daemon: running; restart it for watch changes to take effect.",
        "Run `grovie daemon stop && grovie daemon start`.",
      ].join("\n"),
    });

    expect(runCli(["watch", "remove", "fankaidev/grovie"], { localState, daemonLifecycle })).toEqual({
      exitCode: 0,
      stdout: [
        "grovie watch remove",
        "",
        "Removed fankaidev/grovie.",
        `Config: ${join(globalRoot, "config.yml")}`,
        "Daemon: running; restart it for watch changes to take effect.",
        "Run `grovie daemon stop && grovie daemon start`.",
      ].join("\n"),
    });
  });
});

function createTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grovie-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeIgnoredRepoLocalConfig(cwd: string): void {
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
    start: () => {
      throw new Error("runtime start was not expected");
    },
    resume: () => {
      throw new Error("runtime resume was not expected");
    },
  };
}

function fakeRuntimeAvailability(runtime: RuntimeName): RuntimeAvailability {
  if (runtime === "pi") {
    return {
      runtime,
      command: "pi",
      available: false,
      message: "pi command not found",
    };
  }

  if (runtime === "claude-code") {
    return {
      runtime,
      command: "claude",
      available: true,
      version: "2.1.142 (Claude Code)",
      message: "available (2.1.142 (Claude Code))",
    };
  }

  return fakeRuntime().checkAvailability();
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
    command: [process.execPath, "/project/dist/cli.js", "daemon"],
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

function configureLocalAgent(localState: FakeLocalState, agentNames = ["coder"]): void {
  saveGlobalConfig(localState.paths.root, {
    version: 1,
    agents: agentNames.map((name) => ({
      name,
      runtime: "codex" as const,
      envKeys: ["OPENAI_API_KEY"],
    })),
    watchedRepositories: [],
    adminConsole: {
      enabled: false,
    },
  });
}

class FakeLocalState implements RunLocalState {
  readonly paths: LocalStatePaths;
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
      locksDir: `${root}/locks`,
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
}

function fakeIssue(reference: IssueReference): GitHubIssue {
  return {
    reference,
    title: "Stream runtime output",
    body: "Make runtime logs visible while Codex runs.",
    author: "fankaidev",
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
