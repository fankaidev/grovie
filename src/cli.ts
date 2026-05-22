#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-app.js";

export function main(args: string[]): number {
  const result = runCli(args);

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
  process.exitCode = main(process.argv.slice(2));
}
