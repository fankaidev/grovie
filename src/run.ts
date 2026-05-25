import { finishRun } from "./run/finish.js";
import { mergeCancellationMonitor } from "./run/monitor.js";
import { prepareIssueRun } from "./run/prepare.js";
import type { RunIssueAsyncInput, RunIssueInput, RunIssueResult } from "./run/types.js";

export type { RunIssueAsyncInput, RunIssueInput, RunIssueResult, RunLocalState, RunTriggerContext } from "./run/types.js";

export function runIssue(input: RunIssueInput): RunIssueResult {
  const prepared = prepareIssueRun(input);

  if (!prepared.ok) {
    return prepared.result;
  }

  return finishRun({
    ...prepared,
    issueReference: input.issueReference,
    github: input.github,
    config: input.config,
    configPath: input.configPath,
    resultHandler: input.resultHandler,
    stateRepo: input.stateRepo,
    runtimeResult: prepared.runtime.run({
      run: prepared.run,
      issue: prepared.issue,
      envKeys: input.agentEnvKeys,
    }),
  });
}

export async function runIssueAsync(input: RunIssueAsyncInput): Promise<RunIssueResult> {
  const prepared = prepareIssueRun(input);

  if (!prepared.ok) {
    return prepared.result;
  }

  const runtimeResult =
    prepared.runtime.runAsync === undefined
      ? prepared.runtime.run({
        run: prepared.run,
        issue: prepared.issue,
        envKeys: input.agentEnvKeys,
        monitor: mergeCancellationMonitor(prepared.localState, prepared.run, input.stateRepo, input.monitor),
      })
    : await prepared.runtime.runAsync({
        run: prepared.run,
        issue: prepared.issue,
        envKeys: input.agentEnvKeys,
        monitor: mergeCancellationMonitor(prepared.localState, prepared.run, input.stateRepo, input.monitor),
      });

  return finishRun({
    ...prepared,
    issueReference: input.issueReference,
    github: input.github,
    config: input.config,
    configPath: input.configPath,
    resultHandler: input.resultHandler,
    stateRepo: input.stateRepo,
    runtimeResult,
  });
}
