import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalGrovieConfig } from "./config.js";
import { resolveConfiguredAgents } from "./config.js";
import type { GitHubIssue } from "./github.js";
import type { AgentMetadata } from "./identity.js";
import type { PreparedRun } from "./local-state.js";
import { createRuntime, SUPPORTED_RUNTIMES, type RuntimeAvailability, type RuntimeName } from "./runtime.js";

export type AgentHealth = AgentMetadata & {
  availability: RuntimeAvailability;
};

export type RuntimeAvailabilityChecker = (runtime: RuntimeName) => RuntimeAvailability;

export type AgentVerificationResult = {
  agent: AgentMetadata;
  ok: boolean;
  command: string[];
  stdout?: string;
  stderr?: string;
  message: string;
};

export type AgentVerifier = (agent: AgentMetadata) => AgentVerificationResult;

const AGENT_VERIFICATION_MARKER = "GROVIE_AGENT_OK";

export function getConfiguredAgentHealth(
  config: GlobalGrovieConfig,
  machineId: string,
  checkAvailability: RuntimeAvailabilityChecker = defaultRuntimeAvailabilityChecker,
): AgentHealth[] {
  const availabilityByRuntime = getRuntimeAvailabilityMap(checkAvailability);

  return resolveConfiguredAgents(config, machineId).map((agent) => {
    const availability = availabilityByRuntime.get(agent.runtime) ?? checkAvailability(agent.runtime);

    return {
      ...agent,
      availability,
    };
  });
}

export function getRuntimeHealth(
  checkAvailability: RuntimeAvailabilityChecker = defaultRuntimeAvailabilityChecker,
): RuntimeAvailability[] {
  return [...getRuntimeAvailabilityMap(checkAvailability).values()];
}

function getRuntimeAvailabilityMap(checkAvailability: RuntimeAvailabilityChecker): Map<RuntimeName, RuntimeAvailability> {
  return new Map(SUPPORTED_RUNTIMES.map((runtime) => [runtime, checkAvailability(runtime)]));
}

function defaultRuntimeAvailabilityChecker(runtime: RuntimeName): RuntimeAvailability {
  return createRuntime(runtime).checkAvailability();
}

export function verifyConfiguredAgent(agent: AgentMetadata): AgentVerificationResult {
  const runtime = createRuntime(agent.runtime);
  const run = createVerificationRun(agent);
  const issue = createVerificationIssue();
  const result = runtime.run({
    run,
    issue,
    model: agent.model,
    envKeys: agent.envKeys,
  });
  const stdout = readFileSync(run.stdoutPath, "utf8");
  const stderr = readFileSync(run.stderrPath, "utf8");
  const command = result.execution.command;

  if (result.ok && stdout.includes(AGENT_VERIFICATION_MARKER)) {
    return {
      agent,
      ok: true,
      command,
      stdout,
      stderr,
      message: "verified",
    };
  }

  return {
    agent,
    ok: false,
    command,
    stdout,
    stderr,
    message: result.ok
      ? `Runtime completed but did not output ${AGENT_VERIFICATION_MARKER}.`
      : result.error.message,
  };
}

function createVerificationIssue(): GitHubIssue {
  return {
    reference: {
      owner: "local",
      repo: "grovie-doctor",
      number: 1,
    },
    title: "Grovie agent verification",
    body: `Reply exactly: ${AGENT_VERIFICATION_MARKER}`,
    author: "grovie",
    state: "open",
    updatedAt: new Date(0).toISOString(),
    labels: [],
    comments: [],
    defaultBranch: "main",
  };
}

function createVerificationRun(agent: AgentMetadata): PreparedRun {
  const root = mkdtempSync(join(tmpdir(), "grovie-agent-verify-"));
  const runDir = join(root, "run");
  const sessionDir = join(root, "session");
  const worktreePath = join(root, "worktree");

  mkdirSync(runDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  execFileSync("git", ["init"], {
    cwd: worktreePath,
    stdio: "ignore",
  });

  const taskPath = join(runDir, "task.json");
  const promptPath = join(runDir, "prompt.md");
  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");
  const eventsPath = join(runDir, "events.jsonl");

  writeFileSync(taskPath, `${JSON.stringify({
    schemaVersion: 1,
    runtime: agent.runtime,
    repository: "local/grovie-doctor",
    agentId: agent.agentId,
    agentInstructions: `Reply exactly: ${AGENT_VERIFICATION_MARKER}`,
  }, null, 2)}\n`, "utf8");
  writeFileSync(promptPath, "", "utf8");
  writeFileSync(stdoutPath, "", "utf8");
  writeFileSync(stderrPath, "", "utf8");
  writeFileSync(eventsPath, "", "utf8");

  return {
    sessionId: `doctor-${agent.agentId}`,
    runId: `doctor-${agent.agentId}`,
    agentId: agent.agentId,
    branchName: "grovie/doctor",
    sessionDir,
    repositoryCachePath: join(root, "repo.git"),
    worktreePath,
    runDir,
    taskPath,
    promptPath,
    eventsPath,
    stdoutPath,
    stderrPath,
  };
}
