#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runCliAsync } from "./cli-app.js";
import type { CliTerminal } from "./cli/types.js";

export async function main(args: string[]): Promise<number> {
  const { terminal, close } = createTerminal();

  try {
    const result = await runCliAsync(args, {
      progressWriter: (output) => writeOutput(process.stdout, output),
      terminal,
    });

    writeOutput(process.stdout, result.stdout);
    writeOutput(process.stderr, result.stderr);

    return result.exitCode;
  } finally {
    close();
  }
}

function createTerminal(): { terminal: CliTerminal; close: () => void } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      terminal: {
        isInteractive: false,
        prompt: async () => "",
      },
      close: () => {},
    };
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    terminal: {
      isInteractive: true,
      prompt: (question) => readline.question(question),
    },
    close: () => readline.close(),
  };
}

function writeOutput(stream: NodeJS.WriteStream, output: string | undefined): void {
  if (output === undefined || output.length === 0) {
    return;
  }

  stream.write(output.endsWith("\n") ? output : `${output}\n`);
}

const entrypoint = process.argv[1];

if (entrypoint !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint)) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      writeOutput(process.stderr, error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
