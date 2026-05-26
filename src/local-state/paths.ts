import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalStatePaths } from "./types.js";

export function resolvePaths(overrides: Partial<LocalStatePaths> = {}): LocalStatePaths {
  const root = overrides.root ?? join(homedir(), ".grovie");

  return {
    root,
    reposDir: overrides.reposDir ?? join(root, "repos"),
    worktreesDir: overrides.worktreesDir ?? join(root, "worktrees"),
    runsDir: overrides.runsDir ?? join(root, "runs"),
    locksDir: overrides.locksDir ?? join(root, "locks"),
    sessionsDir: overrides.sessionsDir ?? join(root, "sessions"),
  };
}
