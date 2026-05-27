import { initCommand } from "./command-modules/init.js";
import { doctorCommand } from "./command-modules/doctor.js";
import { statusCommand } from "./command-modules/status.js";
import { runsCommand } from "./command-modules/runs.js";
import { issueCommand } from "./command-modules/issue.js";
import { queueCommand } from "./command-modules/queue.js";
import { daemonCommand } from "./command-modules/daemon.js";
import { stateCommand } from "./command-modules/state.js";
import { watchCommand } from "./command-modules/watch.js";
import type { CliCommand } from "./types.js";

export const commands: readonly CliCommand[] = [
  initCommand,
  doctorCommand,
  statusCommand,
  runsCommand,
  issueCommand,
  queueCommand,
  daemonCommand,
  stateCommand,
  watchCommand,
];
