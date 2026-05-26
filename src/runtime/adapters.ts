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
        ...modelArgs(input.model),
        "--json",
        "--cd",
        input.run.worktreePath,
        "--sandbox",
        "danger-full-access",
        "-",
      ],
      resumeCommand: (sessionId, input) => [
        "codex",
        "--ask-for-approval",
        "never",
        "exec",
        "resume",
        ...modelArgs(input.model),
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
      startCommand: (input) => ["claude", "--permission-mode", "bypassPermissions", ...modelArgs(input.model), "--print"],
      resumeCommand: (sessionId, input) => ["claude", "--permission-mode", "bypassPermissions", ...modelArgs(input.model), "--resume", sessionId, "--print"],
    };
  }

  return {
    runtime,
    command: "pi",
    availabilityArgs: ["--version"],
    startCommand: (input) => ["pi", ...modelArgs(input.model), "--print"],
    resumeCommand: (sessionId, input) => ["pi", ...modelArgs(input.model), "resume", sessionId, "--print"],
  };
}

function modelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
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
