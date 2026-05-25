import { SpawnCommandRunner, type CommandRunner } from "../github.js";
import { checkCliAvailability, getRuntimeAdapter } from "./adapters.js";
import { runRuntimeAsync, runRuntimeSync } from "./execution.js";
import type { AgentRunInput, AgentRuntime, RuntimeAvailability, RuntimeName, RuntimeResumeInput, RuntimeRunResult, RuntimeStartInput } from "./types.js";

export class CodexRuntime implements AgentRuntime {
  readonly name = "codex";

  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {}

  checkAvailability(): RuntimeAvailability {
    const result = this.runner.run("codex", ["--version"]);
    const output = (result.stdout.trim() || result.stderr.trim()).trim();

    if (result.exitCode === 0) {
      return {
        runtime: this.name,
        command: "codex",
        available: true,
        version: output.length > 0 ? output : undefined,
        message: output.length > 0 ? `available (${output})` : "available",
      };
    }

    return {
      runtime: this.name,
      command: "codex",
      available: false,
      message: output.length > 0 ? output : `codex --version failed with exit code ${result.exitCode}.`,
    };
  }

  start(input: RuntimeStartInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner, { mode: "start" });
  }

  resume(input: RuntimeResumeInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner, {
      mode: "resume",
      runtimeSessionRef: input.runtimeSessionRef,
    });
  }

  run(input: AgentRunInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner);
  }

  async runAsync(input: AgentRunInput): Promise<RuntimeRunResult> {
    return runRuntimeAsync(input, getRuntimeAdapter(this.name));
  }
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = "claude-code";

  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {}

  checkAvailability(): RuntimeAvailability {
    return checkCliAvailability(getRuntimeAdapter(this.name), this.runner);
  }

  start(input: RuntimeStartInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner, { mode: "start" });
  }

  resume(input: RuntimeResumeInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner, {
      mode: "resume",
      runtimeSessionRef: input.runtimeSessionRef,
    });
  }

  run(input: AgentRunInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner);
  }

  async runAsync(input: AgentRunInput): Promise<RuntimeRunResult> {
    return runRuntimeAsync(input, getRuntimeAdapter(this.name));
  }
}

export class PiRuntime implements AgentRuntime {
  readonly name = "pi";

  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {}

  checkAvailability(): RuntimeAvailability {
    return checkCliAvailability(getRuntimeAdapter(this.name), this.runner);
  }

  start(input: RuntimeStartInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner, { mode: "start" });
  }

  resume(input: RuntimeResumeInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner, {
      mode: "resume",
      runtimeSessionRef: input.runtimeSessionRef,
    });
  }

  run(input: AgentRunInput): RuntimeRunResult {
    return runRuntimeSync(input, getRuntimeAdapter(this.name), this.runner);
  }

  async runAsync(input: AgentRunInput): Promise<RuntimeRunResult> {
    return runRuntimeAsync(input, getRuntimeAdapter(this.name));
  }
}

export function createRuntime(name: RuntimeName): AgentRuntime {
  if (name === "codex") {
    return new CodexRuntime();
  }

  if (name === "claude-code") {
    return new ClaudeCodeRuntime();
  }

  return new PiRuntime();
}
