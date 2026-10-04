/**
 * Persistent CLI Configuration
 *
 * Stores user preferences (active environment, etc.) in ~/.novaos/config.json.
 * Separate from credentials.json — config survives logout.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

import { CREDENTIALS_DIR, FILE_PERMISSIONS, RETRY_MODES } from "./constants.js";
import { ensureCredentialsDir } from "./ensure-credentials-dir.js";
import {
  type EnvironmentConfigEntry,
  type EnvironmentName,
  type EnvironmentPreset,
  type EnvironmentUrls,
  buildPresetFromConfigEntry,
  describeUnknownEnvironment,
  getEnvironmentConfigPath,
  isValidEnvironment,
  getEnvironment,
  readEnvironmentConfigFile,
  __resetEnvironmentConfigCacheForTests,
} from "./environments.js";
import { type RetryConfig, isValidRetryMode, resolveDefaultRetryConfig } from "./retry-config.js";

const CONFIG_FILE = `${CREDENTIALS_DIR}/config.json`;

const DEFAULT_ENVIRONMENT: EnvironmentName = "local";

interface CliConfig {
  environment?: string;
  /** Active Logto organization ID — used for org-scoped API tokens. */
  activeOrganizationId?: string;
  /** GalaxyHttpClient retry mode — settable by hand-editing this file; --retry-mode and NOVAOS_RETRY_MODE both take priority. */
  retryMode?: string;
  /** GalaxyHttpClient max attempts — settable by hand-editing this file; --max-attempts and NOVAOS_MAX_ATTEMPTS both take priority. */
  maxAttempts?: number;
}

async function readConfig(): Promise<CliConfig> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: CliConfig): Promise<void> {
  await ensureCredentialsDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await chmod(CONFIG_FILE, FILE_PERMISSIONS);
}

/**
 * Persist the active environment name.
 */
export async function setActiveEnvironment(name: EnvironmentName): Promise<void> {
  const config = await readConfig();
  config.environment = name;
  await writeConfig(config);
}

/**
 * Validate and write a named environment into the environments config file
 * (creating it, and its directory, if neither exists yet) — the write path
 * for `env add`, so a developer doesn't have to hand-author the JSON to get
 * started. Merges into any existing entries; an entry of the same name is
 * replaced. Uses ensureCredentialsDir the same way writeConfig does, so the
 * default ~/.novaos directory gets the same permission handling (including
 * its Windows EEXIST-on-existing-directory workaround) as every other file
 * this CLI persists there.
 */
export async function upsertEnvironmentConfigEntry(
  name: string,
  entry: EnvironmentConfigEntry
): Promise<EnvironmentPreset> {
  if (name === "local") {
    throw new Error("\"local\" is the CLI's built-in default and can't be overwritten by env add.");
  }

  // Validate before touching disk — a bad `env add` shouldn't corrupt an
  // otherwise-valid config file.
  const preset = buildPresetFromConfigEntry(name, entry);

  const configPath = getEnvironmentConfigPath();
  const fileContents = readEnvironmentConfigFile(configPath);
  fileContents.environments = { ...fileContents.environments, [name]: entry };

  await ensureCredentialsDir(dirname(configPath));
  await writeFile(configPath, JSON.stringify(fileContents, null, 2) + "\n", "utf-8");
  await chmod(configPath, FILE_PERMISSIONS);

  __resetEnvironmentConfigCacheForTests();

  return preset;
}

/** Which layer decided the active environment or an individual field's value. */
export type EnvironmentSource = "flag" | "env" | "config" | "default";
export type UrlFieldSource = "flag" | "env" | "preset";

/** A resolved environment name plus which layer produced it. */
export interface ResolvedEnvironmentName {
  name: EnvironmentName;
  source: EnvironmentSource;
}

/** A resolved config field's value plus which layer produced it. */
export interface ResolvedField {
  value: string;
  source: UrlFieldSource;
  /** Set when source === "env": the env var that supplied the value. */
  envVar?: string;
  /** Set when source === "flag": the CLI flag that supplied the value. */
  flag?: string;
  /** Set when source === "preset": whether it came from the built-in "local" default or the environments config file. */
  presetOrigin?: "local" | "config-file";
}

export type EnvironmentUrlsWithProvenance = Record<keyof EnvironmentUrls, ResolvedField>;

/**
 * Resolve which named environment is active, and which layer decided it.
 *
 * Priority (highest first):
 *   1. `envFlag` — the global `--env` CLI flag, if passed
 *   2. NOVAOS_ENV env var
 *   3. The persisted `environment` field in ~/.novaos/config.json
 *   4. The hardcoded "local" default
 */
export async function resolveActiveEnvironment(envFlag?: string): Promise<ResolvedEnvironmentName> {
  if (envFlag) {
    if (!isValidEnvironment(envFlag)) {
      throw new Error(describeUnknownEnvironment(envFlag));
    }
    return { name: envFlag, source: "flag" };
  }

  const envVar = process.env.NOVAOS_ENV;
  if (envVar && isValidEnvironment(envVar)) return { name: envVar, source: "env" };

  const config = await readConfig();
  if (config.environment && isValidEnvironment(config.environment)) {
    return { name: config.environment, source: "config" };
  }
  return { name: DEFAULT_ENVIRONMENT, source: "default" };
}

/**
 * Read the persisted environment name (falls back to "local").
 */
export async function getActiveEnvironment(): Promise<EnvironmentName> {
  return (await resolveActiveEnvironment()).name;
}

/** Per-field metadata needed to report provenance (its env var and its CLI flag). */
const URL_FIELD_META: Record<keyof EnvironmentUrls, { envVar: string; flag: string }> = {
  agentOpsUrl: { envVar: "NOVAOS_AGENT_OPS_URL", flag: "--agent-ops-url" },
  mcpOpsUrl: { envVar: "NOVAOS_MCP_OPS_URL", flag: "--mcp-ops-url" },
  reviewUrl: { envVar: "NOVAOS_REVIEW_URL", flag: "--review-url" },
  gatewayUrl: { envVar: "NOVAOS_GATEWAY_URL", flag: "--gateway-url" },
  iamUrl: { envVar: "NOVAOS_IAM_URL", flag: "--iam-url" },
  connectorHostUrl: { envVar: "NOVAOS_CONNECTOR_HOST_URL", flag: "--connector-host-url" },
  clientId: { envVar: "NOVAOS_CLIENT_ID", flag: "--client-id" },
};

/**
 * Resolve effective URLs for the CLI session, plus which layer produced each one.
 *
 * Priority (highest first), per field:
 *   1. `flagOverrides` — the field's own CLI override flag (e.g. --agent-ops-url), if passed
 *   2. Its NOVAOS_<FIELD>_URL / NOVAOS_CLIENT_ID env var
 *   3. The named environment preset's value for that field
 */
export function resolveUrlsWithProvenance(
  envName: EnvironmentName,
  flagOverrides: Partial<EnvironmentUrls> = {}
): EnvironmentUrlsWithProvenance {
  const preset = getEnvironment(envName);
  const result = {} as EnvironmentUrlsWithProvenance;

  for (const key of Object.keys(URL_FIELD_META) as (keyof EnvironmentUrls)[]) {
    const meta = URL_FIELD_META[key];

    const flagValue = flagOverrides[key];
    if (flagValue) {
      result[key] = { value: flagValue, source: "flag", flag: meta.flag };
      continue;
    }

    const envValue = process.env[meta.envVar];
    if (envValue) {
      result[key] = { value: envValue, source: "env", envVar: meta.envVar };
      continue;
    }

    result[key] = { value: preset[key], source: "preset", presetOrigin: preset.presetOrigin };
  }

  return result;
}

/**
 * Resolve effective URLs for the CLI session.
 *
 * Priority (highest first):
 *   1. Explicit env vars (NOVAOS_AGENT_OPS_URL, etc.)
 *   2. Named environment preset
 */
export function resolveUrls(envName: EnvironmentName): EnvironmentUrls {
  const withProvenance = resolveUrlsWithProvenance(envName);
  return {
    agentOpsUrl: withProvenance.agentOpsUrl.value,
    mcpOpsUrl: withProvenance.mcpOpsUrl.value,
    reviewUrl: withProvenance.reviewUrl.value,
    gatewayUrl: withProvenance.gatewayUrl.value,
    iamUrl: withProvenance.iamUrl.value,
    connectorHostUrl: withProvenance.connectorHostUrl.value,
    clientId: withProvenance.clientId.value,
  };
}

/**
 * Active organization from config file only (ignores NOVAOS_ORGANIZATION_ID).
 * Used to decide whether auto-select has already been persisted.
 */
export async function getPersistedOrganizationId(): Promise<string | undefined> {
  const config = await readConfig();
  const id = config.activeOrganizationId?.trim();
  return id && id.length > 0 ? id : undefined;
}

/**
 * Effective active organization for org-scoped Gateway tokens.
 * Env override wins when set (CI / shell); otherwise config file.
 * Mirrors Marketplace `novaos_active_org_id` cookie semantics for the file path.
 */
export async function getActiveOrganizationId(): Promise<string | undefined> {
  const fromEnv = process.env.NOVAOS_ORGANIZATION_ID?.trim();
  if (fromEnv) return fromEnv;

  return getPersistedOrganizationId();
}

export async function setActiveOrganizationId(organizationId: string | undefined): Promise<void> {
  const config = await readConfig();
  if (organizationId === undefined || organizationId.trim().length === 0) {
    delete config.activeOrganizationId;
  } else {
    config.activeOrganizationId = organizationId.trim();
  }
  await writeConfig(config);
}

/**
 * Resolve GalaxyHttpClient retry config.
 * Priority (highest first): explicit overrides (CLI flag) → env vars
 * (NOVAOS_RETRY_MODE / NOVAOS_MAX_ATTEMPTS) → config file → built-in default.
 */
export async function resolveRetryConfig(overrides?: {
  mode?: string;
  maxAttempts?: number;
}): Promise<RetryConfig> {
  const envDefault = resolveDefaultRetryConfig();
  const config = await readConfig();

  let mode = envDefault.mode;
  if (!process.env.NOVAOS_RETRY_MODE && config.retryMode && isValidRetryMode(config.retryMode)) {
    mode = config.retryMode;
  }
  if (overrides?.mode !== undefined) {
    if (!isValidRetryMode(overrides.mode)) {
      throw new Error(`Unknown --retry-mode "${overrides.mode}". Valid: ${RETRY_MODES.join(", ")}`);
    }
    mode = overrides.mode;
  }

  let maxAttempts = envDefault.maxAttempts;
  if (
    !process.env.NOVAOS_MAX_ATTEMPTS &&
    typeof config.maxAttempts === "number" &&
    config.maxAttempts >= 1
  ) {
    maxAttempts = config.maxAttempts;
  }
  if (overrides?.maxAttempts !== undefined) {
    if (!Number.isFinite(overrides.maxAttempts) || overrides.maxAttempts < 1) {
      throw new Error(
        `Invalid --max-attempts "${overrides.maxAttempts}": must be a positive integer.`
      );
    }
    maxAttempts = overrides.maxAttempts;
  }

  return { mode, maxAttempts };
}
