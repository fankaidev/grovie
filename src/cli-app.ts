import { createServer } from "node:http";
import { startAdminConsoleServer, type AdminConsoleResolvedConfig } from "./admin-console.js";
import { LocalDaemonLifecycle } from "./daemon-lifecycle.js";
import { GhGitHubGateway } from "./github.js";
import { LocalState } from "./local-state.js";
import { GROVIE_VERSION } from "./version.js";
import { commands } from "./cli/commands.js";
import { renderCommandHelp, renderHelp as renderCliHelp } from "./cli/render.js";
import type { CliContext, CliResult } from "./cli/types.js";

export type { AdminConsolePortCheck, CliCommand, CliContext, CliResult } from "./cli/types.js";
export { commands } from "./cli/commands.js";

export function runCli(args: string[], context: Partial<CliContext> = {}): CliResult {
  const result = runCliInternal(args, context);

  if (isPromise(result)) {
    throw new Error("Command requires asynchronous execution. Use runCliAsync.");
  }

  return result;
}

export async function runCliAsync(args: string[], context: Partial<CliContext> = {}): Promise<CliResult> {
  return runCliInternal(args, context);
}

function runCliInternal(args: string[], context: Partial<CliContext> = {}): CliResult | Promise<CliResult> {
  const cliContext = {
    cwd: context.cwd ?? process.cwd(),
    github: context.github ?? new GhGitHubGateway(),
    runtime: context.runtime,
    runtimeAvailabilityChecker: context.runtimeAvailabilityChecker,
    agentVerifier: context.agentVerifier,
    localState: context.localState ?? new LocalState(),
    daemonLifecycle: context.daemonLifecycle ?? new LocalDaemonLifecycle(),
    adminConsolePortCheck: context.adminConsolePortCheck ?? checkAdminConsolePortAvailable,
    adminConsoleStarter: context.adminConsoleStarter ?? startAdminConsoleServer,
  };
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [commandName, ...commandArgs] = normalizedArgs;

  if (commandName === undefined || commandName === "--help" || commandName === "-h" || commandName === "help") {
    return {
      exitCode: 0,
      stdout: renderHelp(),
    };
  }

  if (commandName === "--version" || commandName === "-v") {
    return {
      exitCode: 0,
      stdout: GROVIE_VERSION,
    };
  }

  const command = commands.find((candidate) => candidate.name === commandName);

  if (command === undefined) {
    return {
      exitCode: 1,
      stderr: "Unknown command: " + commandName + "\n\n" + renderHelp(),
    };
  }

  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    return {
      exitCode: 0,
      stdout: renderCommandHelp(command),
    };
  }

  return command.run(commandArgs, cliContext);
}

function checkAdminConsolePortAvailable(config: AdminConsoleResolvedConfig): Promise<void> {
  if (!config.enabled) {
    return Promise.resolve();
  }

  const server = createServer();

  return new Promise((resolve, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error("Admin console port " + config.port + " is unavailable on " + config.host + "."));
    };
    const onListening = () => {
      server.off("error", onError);
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

function isPromise(value: CliResult | Promise<CliResult>): value is Promise<CliResult> {
  return typeof (value as Promise<CliResult>).then === "function";
}

export function renderHelp(): string {
  return renderCliHelp(commands);
}
