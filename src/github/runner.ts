import { spawnSync } from "node:child_process";

import type { CommandResult, CommandRunner, CommandRunOptions } from "./types.js";

export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: string[], input?: string, options: CommandRunOptions = {}): CommandResult {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      input,
      maxBuffer: options.maxBuffer,
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
