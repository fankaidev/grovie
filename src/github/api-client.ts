import type { CommandRunner, Result } from "./types.js";

export class GhApiClient {
  constructor(private readonly runner: CommandRunner) {}

  json<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      paginate?: boolean;
      slurp?: boolean;
    } = {},
  ): Result<T> {
    const args = ["api"];

    if (options.method !== undefined) {
      args.push("-X", options.method);
    }

    if (options.paginate === true) {
      args.push("--paginate");
    }

    if (options.slurp === true) {
      args.push("--slurp");
    }

    args.push(path);

    const input = options.body === undefined ? undefined : `${JSON.stringify(options.body)}\n`;

    if (input !== undefined) {
      args.push("--input", "-");
    }

    const result = this.runner.run("gh", args, input);

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "gh_failed",
          message: result.stderr.trim() || `gh ${args.join(" ")} failed with exit code ${result.exitCode}.`,
          command: `gh ${args.join(" ")}`,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    }

    if (result.stdout.trim().length === 0) {
      return {
        ok: true,
        value: undefined as T,
      };
    }

    try {
      return {
        ok: true,
        value: JSON.parse(result.stdout) as T,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error: {
          code: "invalid_json",
          message: `gh ${args.join(" ")} returned invalid JSON: ${message}`,
          command: `gh ${args.join(" ")}`,
          stderr: result.stdout,
        },
      };
    }
  }
}
