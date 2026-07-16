/**
 * Build the minimal environment inherited by official delegated CLI processes.
 *
 * Delegated tools need executable lookup, platform/home directories, locale,
 * proxy and certificate configuration, plus their explicit credential-home
 * locations. They must not receive unrelated provider keys or process-injected
 * StrongCode credentials.
 */
const DELEGATED_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "BROWSER",
  "COLORTERM",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "OS",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR"
]);

const CODEX_ENVIRONMENT_KEYS = new Set(["CODEX_HOME"]);
const GCLOUD_ENVIRONMENT_KEYS = new Set([
  "CLOUDSDK_CONFIG",
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT"
]);

export type DelegatedEnvironmentKind = "generic" | "codex" | "gcloud";

function isAllowedDelegatedEnvironmentKey(key: string, kind: DelegatedEnvironmentKind): boolean {
  const normalized = key.toUpperCase();
  return DELEGATED_ENVIRONMENT_KEYS.has(normalized)
    || /^LC_[A-Z0-9_]+$/.test(normalized)
    || (kind === "codex" && CODEX_ENVIRONMENT_KEYS.has(normalized))
    || (kind === "gcloud" && GCLOUD_ENVIRONMENT_KEYS.has(normalized));
}

/** Merge explicit overrides over the parent environment, then apply the allowlist. */
export function buildDelegatedProcessEnv(
  overrides: NodeJS.ProcessEnv = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  kind: DelegatedEnvironmentKind = "generic"
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const merged = { ...baseEnvironment, ...overrides };

  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || !isAllowedDelegatedEnvironmentKey(key, kind)) continue;

    if (process.platform === "win32") {
      const duplicate = Object.keys(result).find(existing => existing.toUpperCase() === key.toUpperCase());
      if (duplicate) delete result[duplicate];
    }
    result[key] = value;
  }

  // This process-wide credential payload is intentionally denied even if the
  // allowlist is expanded in the future.
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === "STRONGCODE_AUTH_CONTENT") delete result[key];
  }
  return result;
}

export function buildCodexProcessEnv(overrides: NodeJS.ProcessEnv = {}, baseEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildDelegatedProcessEnv(overrides, baseEnvironment, "codex");
}

export function buildGcloudProcessEnv(overrides: NodeJS.ProcessEnv = {}, baseEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildDelegatedProcessEnv(overrides, baseEnvironment, "gcloud");
}
