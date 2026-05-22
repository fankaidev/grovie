#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCliAsync } from "./cli-app.js";

export async function main(args: string[]): Promise<number> {
  const result = await runCliAsync(args);

  writeOutput(process.stdout, result.stdout);
  writeOutput(process.stderr, result.stderr);

  return result.exitCode;
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
