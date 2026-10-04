/**
 * Environment Configuration
 *
 * The CLI ships with exactly one built-in environment, "local" — a
 * convenience default for talking to services running on your own machine
 * on their conventional ports. It carries no backend-specific identity and
 * is fully overridable, like any other environment, via --*-url flags or
 * NOVAOS_*_URL env vars.
 *
 * Every other named environment is supplied by the user through a config
 * file (see getEnvironmentConfigPath below) rather than compiled in.
 * This keeps operators — NovaOS-hosted or self-hosted — in charge of which
 * backends their CLI talks to, and keeps that set out of the public
 * package entirely.
 *
 * Per-URL resolution priority (highest wins):
 *   1. Explicit CLI flag (--agent-ops-url, etc.)
 *   2. Environment variable (NOVAOS_AGENT_OPS_URL, etc.)
 *   3. The named environment's entry in the config file (--env flag or persisted config)
 *   4. "local" preset (localhost defaults)
 * A name that resolves to none of the above — not "local" and not in the
 * config file — is an error naming exactly how to add it (see
 * describeUnknownEnvironment below), never a silent fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EnvironmentName = string;

export type ServiceEnvironmentTier = "dev" | "staging" | "production";

export interface EnvironmentUrls {
  agentOpsUrl: string;
  mcpOpsUrl: string;
  reviewUrl: string;
  gatewayUrl: string;
  iamUrl: string;
  /** Connector Registry / connector-host admin API — used by `connector list`/`register`/`publish`. */
  connectorHostUrl: string;
  clientId: string;
}

export interface EnvironmentPreset extends EnvironmentUrls {
  name: EnvironmentName;
  label: string;
  apiBase: string;
  /** Marketplace admin API host (separate subdomain from apiBase). Optional — not every environment exposes one. */
  marketplaceUrl?: string;
  /** Which service-registry tier this environment maps to. Defaults to "dev" when unset. */
  serviceEnvironment?: ServiceEnvironmentTier;
  /** Where this preset's values came from — for provenance reporting (env show --verbose) only. */
  presetOrigin: "local" | "config-file";
}

/** Config-file shape for a single user-supplied named environment. */
export interface EnvironmentConfigEntry extends Partial<EnvironmentUrls> {
  label?: string;
  apiBase?: string;
  marketplaceUrl?: string;
  serviceEnvironment?: ServiceEnvironmentTier;
}

export interface EnvironmentConfigFileShape {
  environments?: Record<string, EnvironmentConfigEntry>;
}

// Seeded by infra/environments/local/scripts/seed-logto-kind.sh as the CLI's
// OAuth client in the local Logto instance — the same well-known id every
// local dev environment seeds, not a secret.
const LOCAL_CLIENT_ID = "dr6dkwvfetk6gzwrte1zf";

/**
 * The only environment preset the CLI ships with. No customer or
 * NovaOS-environment identity — just the CLI's own conventional local ports.
 */
export const LOCAL_ENVIRONMENT_PRESET: EnvironmentPreset = {
  name: "local",
  label: "Local Development",
  apiBase: "http://localhost",
  agentOpsUrl: "http://localhost:3400",
  mcpOpsUrl: "http://localhost:3500",
  reviewUrl: "http://localhost:3600",
  gatewayUrl: "http://localhost:3000",
  iamUrl: "http://localhost:3001",
  connectorHostUrl: "http://localhost:3700",
  clientId: LOCAL_CLIENT_ID,
  marketplaceUrl: "http://localhost:3100",
  serviceEnvironment: "dev",
  presetOrigin: "local",
};

/** Canonical location of the user-supplied environments config file. */
export function getEnvironmentConfigPath(): string {
  return process.env.NOVAOS_ENV_CONFIG?.trim() || join(homedir(), ".novaos", "environments.json");
}

const URL_FIELDS: readonly Exclude<keyof EnvironmentUrls, "clientId">[] = [
  "agentOpsUrl",
  "mcpOpsUrl",
  "reviewUrl",
  "gatewayUrl",
  "iamUrl",
  "connectorHostUrl",
];

// Field-name -> URL path segment (agentOpsUrl -> agent-ops, mcpOpsUrl -> mcp-ops, etc.)
//
// connectorHostUrl derives to "s2s/connector", not "connector-host": connector-host
// has no public ingress route of its own (its NetworkPolicy only admits traffic from
// S2S Gateway, MCP Gateway and Marketplace BFF — never the public gateway directly),
// so a named environment's apiBase-derived default must go through the S2S Gateway's
// "/s2s" public path, which proxies its own "/connector" prefix to connector-host.
const PATH_SEGMENTS: Record<Exclude<keyof EnvironmentUrls, "clientId">, string> = {
  agentOpsUrl: "agent-ops",
  mcpOpsUrl: "mcp-ops",
  reviewUrl: "review",
  gatewayUrl: "gateway",
  iamUrl: "iam",
  connectorHostUrl: "s2s/connector",
};

/**
 * Validate a config entry and resolve it to a full preset, or throw a
 * specific error naming exactly which field(s) are missing. Exported so
 * `env add` can validate before writing, not just when the CLI later
 * reads the file back.
 */
export function buildPresetFromConfigEntry(
  name: string,
  entry: EnvironmentConfigEntry
): EnvironmentPreset {
  const apiBase = entry.apiBase?.replace(/\/$/, "");
  const missing: string[] = [];

  const urls: Partial<EnvironmentUrls> = {};
  for (const field of URL_FIELDS) {
    const explicit = entry[field];
    if (explicit) {
      urls[field] = explicit;
    } else if (apiBase) {
      urls[field] = `${apiBase}/${PATH_SEGMENTS[field]}`;
    } else {
      missing.push(field);
    }
  }

  if (!entry.clientId) missing.push("clientId");

  if (missing.length > 0) {
    throw new Error(
      `Environment config entry "${name}" is missing ${missing.join(", ")}. ` +
        `Provide each field explicitly, or set "apiBase" so agentOpsUrl/mcpOpsUrl/reviewUrl/gatewayUrl/iamUrl/connectorHostUrl ` +
        `can be derived from it (clientId always requires an explicit value).`
    );
  }

  return {
    name,
    label: entry.label ?? name,
    apiBase: apiBase ?? "",
    agentOpsUrl: urls.agentOpsUrl!,
    mcpOpsUrl: urls.mcpOpsUrl!,
    reviewUrl: urls.reviewUrl!,
    gatewayUrl: urls.gatewayUrl!,
    iamUrl: urls.iamUrl!,
    connectorHostUrl: urls.connectorHostUrl!,
    clientId: entry.clientId!,
    marketplaceUrl: entry.marketplaceUrl,
    serviceEnvironment: entry.serviceEnvironment,
    presetOrigin: "config-file",
  };
}

let cachedEnvironments: Record<string, EnvironmentPreset> | undefined;
/** Names present in the config file that failed validation, and why — kept so a later lookup of exactly that name can report its real reason instead of a generic "unknown". */
let cachedInvalidEnvironments: Record<string, string> | undefined;

/**
 * A malformed config file, or one bad entry in it, must never take down
 * every CLI invocation (including --help) — this mirrors the sandbox's
 * "skip and warn" handling of its own tool-response config file. "local"
 * and every other valid entry keep working; only the broken name is
 * unusable, and only when someone actually asks for it.
 */
function loadEnvironments(): Record<string, EnvironmentPreset> {
  if (cachedEnvironments) return cachedEnvironments;

  const result: Record<string, EnvironmentPreset> = { local: LOCAL_ENVIRONMENT_PRESET };
  const invalid: Record<string, string> = {};
  const configPath = getEnvironmentConfigPath();

  if (existsSync(configPath)) {
    let parsed: EnvironmentConfigFileShape;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8")) as EnvironmentConfigFileShape;
    } catch (error) {
      process.stderr.write(
        `⚠ Ignoring environment config file at ${configPath}: ${(error as Error).message}\n` +
          `  Only "local" is available until this file is fixed.\n`
      );
      parsed = {};
    }
    for (const [name, entry] of Object.entries(parsed.environments ?? {})) {
      try {
        result[name] = buildPresetFromConfigEntry(name, entry);
      } catch (error) {
        const reason = (error as Error).message;
        invalid[name] = reason;
        process.stderr.write(
          `⚠ Skipping invalid environment "${name}" in ${configPath}:\n  - ${reason}\n`
        );
      }
    }
  }

  cachedEnvironments = result;
  cachedInvalidEnvironments = invalid;
  return result;
}

/** Test-only: force the next call to re-read the config file from disk. */
export function __resetEnvironmentConfigCacheForTests(): void {
  cachedEnvironments = undefined;
  cachedInvalidEnvironments = undefined;
}

export function getEnvironments(): Record<string, EnvironmentPreset> {
  return loadEnvironments();
}

export function getEnvironmentNames(): string[] {
  return Object.keys(loadEnvironments());
}

export function isValidEnvironment(name: string): name is EnvironmentName {
  return name in loadEnvironments();
}

/**
 * Single env-var-vs-default resolution rule, shared by every caller that
 * needs "explicit env var, else a fallback value" (constants.ts's DEFAULT_*
 * exports and config.ts's resolveUrls()) so the precedence logic itself
 * isn't duplicated alongside the values it resolves.
 */
export function resolveFromEnv(envVar: string, fallback: string): string {
  return process.env[envVar] || fallback;
}

/**
 * Full guidance for an --env value that didn't resolve, naming exactly how
 * to fix it: the specific validation failure if the name is configured but
 * broken, or how to add it (via `env add` or by hand-editing the config
 * file) if it isn't configured at all.
 */
export function describeUnknownEnvironment(name: string): string {
  loadEnvironments();
  const invalidReason = cachedInvalidEnvironments?.[name];
  if (invalidReason) {
    return `Environment "${name}" is configured but invalid: ${invalidReason}`;
  }
  return (
    `Unknown environment "${name}". Valid: ${getEnvironmentNames().join(", ")}\n` +
    `To add it, run \`novaos-cli env add ${name} --api-base <url> --client-id <id>\` ` +
    `(or add it directly to ${getEnvironmentConfigPath()}).`
  );
}

export function getEnvironment(name: EnvironmentName): EnvironmentPreset {
  const preset = loadEnvironments()[name];
  if (!preset) {
    throw new Error(describeUnknownEnvironment(name));
  }
  return preset;
}

/**
 * Best-effort tier for an environment name that has no explicit
 * "serviceEnvironment" configured — matches the naming convention NovaOS's
 * own environments already use, so existing "staging"/"production-*"-style
 * names keep working without requiring config. Anything else defaults to
 * "dev", same as before named environments were configurable.
 */
function inferServiceEnvironmentTier(env: EnvironmentName): ServiceEnvironmentTier {
  if (env === "prod" || env.startsWith("production")) return "production";
  if (env === "fde" || env.startsWith("staging")) return "staging";
  return "dev";
}

/**
 * Map CLI environment name to service-registry environment.
 * service-registry uses "dev | staging | production"; "local" always maps to
 * "dev" (Kind clusters behave as dev). Any other environment's tier comes
 * from its config entry's "serviceEnvironment" field when set, else a
 * name-based inference (see inferServiceEnvironmentTier) so unconfigured
 * "staging"/"production-*"-style names don't silently fall back to "dev".
 */
export function cliEnvToServiceEnvironment(env: EnvironmentName): ServiceEnvironmentTier {
  if (env === "local") return "dev";
  return loadEnvironments()[env]?.serviceEnvironment ?? inferServiceEnvironmentTier(env);
}

/**
 * Read the environment config file's raw contents (or `{}` if it doesn't
 * exist), for a writer to merge into. Exported so config.ts's `env add`
 * writer doesn't have to duplicate the parsing/shape logic — kept in this
 * file alongside everything else that understands that shape.
 */
export function readEnvironmentConfigFile(configPath: string): EnvironmentConfigFileShape {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as EnvironmentConfigFileShape;
  } catch (error) {
    throw new Error(
      `Refusing to overwrite ${configPath}: it exists but failed to parse (${(error as Error).message}). ` +
        `Fix or remove it first.`
    );
  }
}
