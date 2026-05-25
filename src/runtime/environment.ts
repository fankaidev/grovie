const BASELINE_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
] as const;

export function buildRuntimeEnvironment(envKeys: readonly string[] = [], sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of [...BASELINE_ENV_KEYS, ...envKeys]) {
    const value = sourceEnv[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
