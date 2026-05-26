import { getConfiguredAgentHealth, getRuntimeHealth, verifyConfiguredAgent, type AgentVerifier } from "../../agent-health.js";
import { buildAgentLabel } from "../../assignment.js";
import { createAdminConsoleServer, resolveAdminConsoleConfig, startAdminConsoleServer } from "../../admin-console.js";
import {
  addWatchedRepository,
  defaultConfig,
  loadGlobalConfig,
  removeWatchedRepository,
  resolveConfiguredAgents,
  saveGlobalConfig,
} from "../../config.js";
import { cleanupLocalState, parseOlderThan, renderCleanupResult } from "../../cleanup.js";
import { NO_LOCAL_AGENTS_MESSAGE, runDaemon, runDaemonForRepositories } from "../../daemon.js";
import { followDaemonLogs, parseDaemonLogStream, readDaemonLogs } from "../../daemon-logs.js";
import { renderDaemonLifecycleStatus } from "../../daemon-lifecycle.js";
import { getDaemonServicePath, installDaemonService, parseDaemonServicePlatform, renderDaemonServiceResult, uninstallDaemonService } from "../../daemon-service.js";
import { formatIssueReference, parseIssueReference } from "../../github.js";
import { resolveLocalIdentity } from "../../identity.js";
import { inspectQueue, renderQueueInspection } from "../../queue.js";
import { findLocalRun, listLocalRuns, renderLocalStatusOverview, renderRunDetail, renderRunsList } from "../../status.js";
import { initStateRepository } from "../../state-repo.js";
import {
  checkRuntimeAvailability,
  errorResult,
  githubErrorResult,
  readNumberOption,
  readStringOption,
  renderConfiguredAgents,
  renderAgentVerificationResult,
  renderAgentVerificationResults,
  renderFailedAgentVerifications,
  renderGlobalConfigSource,
  renderRuntimeHealth,
  renderUnavailableAgents,
  resolveQueueTrustedAuthors,
  startDaemonProcess,
} from "../command-support.js";
import type { CliCommand, CliContext } from "../types.js";

export const doctorCommand = {
    name: "doctor",
    description: "Check global Grovie config and local prerequisites.",
    usage: "grovie doctor [--verify-agents]",
    issue: "#3",
    run: (args: string[], context: CliContext) => {
      try {
        const verifyAgents = args.includes("--verify-agents");
        const unknownArgs = args.filter((arg) => arg !== "--verify-agents");

        if (unknownArgs.length > 0) {
          return {
            exitCode: 1,
            stderr: `Unknown doctor option: ${unknownArgs[0]}`,
          };
        }

        const globalConfig = loadGlobalConfig(context.localState.getPaths().root);
        const authenticatedUser = context.github.getAuthenticatedUser();
        const identity = resolveLocalIdentity();

        if (!authenticatedUser.ok) {
          return githubErrorResult(authenticatedUser.error);
        }

        const runtimeHealth = getRuntimeHealth((runtimeName) => checkRuntimeAvailability(context, runtimeName));
        const agentHealth = getConfiguredAgentHealth(
          globalConfig.config,
          identity.machineId,
          (runtimeName) => checkRuntimeAvailability(context, runtimeName),
        );
        const doctorOutput = [
          "grovie doctor",
          verifyAgents ? "Mode: deep configured-agent verification. This may call remote model providers and consume credits." : "Mode: fast local check. Agent execution is not verified; run `grovie doctor --verify-agents` for deep checks.",
          "",
          `Global config: ${renderGlobalConfigSource(globalConfig.path, globalConfig.config.watchedRepositories.length)}`,
          `Machine id: ${identity.machineId}`,
          ...renderRuntimeHealth(runtimeHealth),
          ...renderConfiguredAgents(agentHealth),
          `GitHub: authenticated as ${authenticatedUser.value.login}.`,
        ];

        const unavailableAgents = agentHealth.filter((agent) => !agent.availability.available);

        if (!verifyAgents && unavailableAgents.length > 0) {
          return {
            exitCode: 1,
            stdout: doctorOutput.join("\n"),
            stderr: renderUnavailableAgents(unavailableAgents),
          };
        }

        if (verifyAgents) {
          const verifier = context.agentVerifier ?? verifyConfiguredAgent;
          const progressWriter = context.progressWriter;
          const streamingOutput = progressWriter !== undefined;

          if (streamingOutput) {
            progressWriter([
              ...doctorOutput,
              "Agent execution verification:",
              "This check runs real agent invocations and may use network access or provider credits.",
            ].join("\n"));
          }

          const verificationResults = agentHealth.map((agent) => {
            const result = agent.availability.available
              ? safelyVerifyAgent(verifier, agent)
              : {
                  agent,
                  ok: false,
                  command: [agent.availability.command],
                  message: `runtime unavailable: ${agent.availability.message}`,
                };

            if (streamingOutput) {
              progressWriter(renderAgentVerificationResult(result));
            }

            return result;
          });
          const failedVerifications = verificationResults.filter((result) => !result.ok);
          const output = [
            ...doctorOutput,
            ...renderAgentVerificationResults(verificationResults),
          ];

          if (failedVerifications.length > 0) {
            return {
              exitCode: 1,
              stdout: streamingOutput ? undefined : output.join("\n"),
              stderr: renderFailedAgentVerifications(verificationResults),
            };
          }

          return {
            exitCode: 0,
            stdout: streamingOutput ? undefined : output.join("\n"),
          };
        }

        return {
          exitCode: 0,
          stdout: doctorOutput.join("\n"),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  } satisfies CliCommand;

function safelyVerifyAgent(verifier: AgentVerifier, agent: Parameters<AgentVerifier>[0]): ReturnType<AgentVerifier> {
  try {
    return verifier(agent);
  } catch (error) {
    return {
      agent,
      ok: false,
      command: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
