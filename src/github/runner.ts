import { spawnSync } from "node:child_process";

import type { CommandResult, CommandRunner, CommandRunOptions } from "./types.js";

export class SpawnCommandRunner implements CommandRunner {
  constructor(private readonly defaults: CommandRunOptions = {}) {}

  run(command: string, args: string[], input?: string, options: CommandRunOptions = {}): CommandResult {
    const resolvedOptions = {
      ...this.defaults,
      ...options,
    };
    const result = spawnSync(command, args, {
      encoding: "utf8",
      cwd: resolvedOptions.cwd,
      env: resolvedOptions.env,
      input,
      maxBuffer: resolvedOptions.maxBuffer,
      timeout: resolvedOptions.timeoutMs,
    });

    if (result.error !== undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: result.error.message,
      };
    }

    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}
