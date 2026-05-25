import type { CommandRunner } from "../github.js";
import type { AgentRunInput, RuntimeAdapter, RuntimeAvailability, RuntimeName } from "./types.js";

export function getRuntimeAdapter(runtime: RuntimeName): RuntimeAdapter {
  if (runtime === "codex") {
    return {
      runtime,
      command: "codex",
      availabilityArgs: ["--version"],
      startCommand: (input) => [
        "codex",
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--cd",
        input.run.worktreePath,
        "--sandbox",
        "danger-full-access",
        "-",
      ],
      resumeCommand: (sessionId) => [
        "codex",
        "--ask-for-approval",
        "never",
        "exec",
        "resume",
        "--json",
        sessionId,
        "-",
      ],
    };
  }

  if (runtime === "claude-code") {
    return {
      runtime,
      command: "claude",
      availabilityArgs: ["--version"],
      startCommand: () => ["claude", "--permission-mode", "bypassPermissions", "--print"],
      resumeCommand: (sessionId) => ["claude", "--permission-mode", "bypassPermissions", "--resume", sessionId, "--print"],
    };
  }

  return {
    runtime,
    command: "pi",
    availabilityArgs: ["--version"],
    startCommand: () => ["pi", "-"],
    resumeCommand: (sessionId) => ["pi", "resume", sessionId, "-"],
  };
}

export function checkCliAvailability(adapter: RuntimeAdapter, runner: CommandRunner): RuntimeAvailability {
  const result = runner.run(adapter.command, adapter.availabilityArgs);
  const output = (result.stdout.trim() || result.stderr.trim()).trim();

  if (result.exitCode === 0) {
    return {
      runtime: adapter.runtime,
      command: adapter.command,
      available: true,
      version: output.length > 0 ? output : undefined,
      message: output.length > 0 ? `available (${output})` : "available",
    };
  }

  return {
    runtime: adapter.runtime,
    command: adapter.command,
    available: false,
    message: output.length > 0 ? output : `${adapter.command} --version failed with exit code ${result.exitCode}.`,
  };
}
