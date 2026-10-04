/**
 * novaos-cli Constants
 *
 * All named constants used across the CLI. No magic numbers or hardcoded
 * literals should appear outside this file.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { LOCAL_ENVIRONMENT_PRESET, resolveFromEnv } from "./environments.js";

// ---- Credential Storage ----

export const CREDENTIALS_DIR = join(homedir(), ".novaos");
export const CREDENTIALS_FILE_PATH = join(CREDENTIALS_DIR, "credentials.json");
export const FILE_PERMISSIONS = 0o600;
export const DIR_PERMISSIONS = 0o700;

// ---- Token Management ----

export const TOKEN_REFRESH_BUFFER_SECONDS = 60;

// ---- PKCE / Authorization Code Flow ----

export const PKCE_CALLBACK_PORTS = [8976, 8977, 8978];
export const PKCE_CALLBACK_PATH = "/callback";
export const PKCE_CODE_VERIFIER_LENGTH = 64;
export const AUTH_TIMEOUT_MS = 120_000;

// ---- IAM Configuration (from environment) ----
// Fallbacks derive from the "local" environment preset (environments.ts) so
// the values have a single source of truth instead of a hand-duplicated copy.

export const DEFAULT_IAM_URL = resolveFromEnv("NOVAOS_IAM_URL", LOCAL_ENVIRONMENT_PRESET.iamUrl);
export const DEFAULT_CLIENT_ID = resolveFromEnv(
  "NOVAOS_CLIENT_ID",
  LOCAL_ENVIRONMENT_PRESET.clientId
);
export const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "roles",
  "urn:logto:scope:organizations",
  "urn:logto:scope:organization_roles",
  "agent:*",
  "mcp:tools:*",
  "llm:model:*",
  "memory:read:user",
  "memory:read:agent",
  "memory:read:run",
  "memory:read:task",
  "memory:read:conversation",
  "memory:read:tenant",
  "memory:write:agent",
  "memory:write:run",
  "memory:write:task",
  "memory:write:tenant",
  "memory:delete:agent",
  "memory:delete:run",
  "memory:delete:task",
  "memory:delete:user",
  "memory:delete:tenant",
  "memory:explain:retrieval",
  "memory:hint:consolidation",
  "rag:collections:read",
  "rag:collections:write",
  "rag:ingest",
  "rag:query",
  "connector:list",
  "connector:publish",
  "connector:configure",
  "connector:invoke",
  "platform:admin",
].join(" ");

// ---- API Resource (required for JWT access tokens from Logto) ----

export const DEFAULT_API_RESOURCE = process.env.NOVAOS_API_RESOURCE || "urn:novaos";

// ---- Role-Based Access ----

export const REQUIRED_CLI_ROLE = "developer";
export const ROLES_CLAIM_PATHS = ["roles", "urn:logto:roles"];

// ---- Backend Service URLs (fallbacks when no named environment is active) ----
// Fallbacks derive from the "local" environment preset (environments.ts), same
// as the IAM configuration above.

export const DEFAULT_AGENT_OPS_URL = resolveFromEnv(
  "NOVAOS_AGENT_OPS_URL",
  LOCAL_ENVIRONMENT_PRESET.agentOpsUrl
);
export const DEFAULT_MCP_OPS_URL = resolveFromEnv(
  "NOVAOS_MCP_OPS_URL",
  LOCAL_ENVIRONMENT_PRESET.mcpOpsUrl
);
export const DEFAULT_REVIEW_URL = resolveFromEnv(
  "NOVAOS_REVIEW_URL",
  LOCAL_ENVIRONMENT_PRESET.reviewUrl
);
export const DEFAULT_GATEWAY_URL = resolveFromEnv(
  "NOVAOS_GATEWAY_URL",
  LOCAL_ENVIRONMENT_PRESET.gatewayUrl
);

// ---- Registry URL Rewrite (host → cluster mapping) ----

export const REGISTRY_MAP = process.env.NOVAOS_REGISTRY_MAP ?? "";

// ---- Evaluation Regression Detection ----

export const EXIT_REGRESSION = 3;
export const DEFAULT_REGRESSION_THRESHOLD = 0.05;

import pkg from "../package.json";

// ---- HTTP Client ----

export const USER_AGENT = `galaxy-cli/${pkg.version}`;
export const MAX_AUTH_RETRIES = 1;
export const REQUEST_TIMEOUT_MS = 30_000;

// ---- HTTP Client Retry/Backoff ----
// Mirrors AWS CLI's retry_mode/max_attempts naming and precedence
// (--flag > env var > config file > default).

export const RETRY_MODES = ["none", "standard", "adaptive"] as const;
export const DEFAULT_RETRY_MODE = "standard" as const;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 200;
export const RETRY_MAX_DELAY_MS = 5_000;

// ---- Platform Security Limits ----

export { APPROVED_BASE_IMAGES } from "@novaos-cli/shared/security-scanner/approved-images";

export const PLATFORM_MAX_MEMORY_MB = 4096;
export const PLATFORM_MAX_CPU_MILLICORES = 4000;

// ---- Python agent SDK ----

// The public PyPI package generated agents actually depend on. This is the
// install source of truth — scaffolded agents get it via `pip install`, not
// git vendoring.
export const PYTHON_AGENT_SDK_PYPI_PACKAGE = "novaos-agent-sdk";

// Pinned SDK version scaffolded into every new Python agent's requirements.txt.
// Only the A2A version line is targeted; bump this when a new pinned version
// should roll out to newly-scaffolded agents. Pinned to the highest version
// actually published on the index above — verify a new value resolves there
// before bumping it, since an unpublished pin breaks every fresh scaffold's
// `pip install`.
export const PYTHON_AGENT_SDK_VERSION = "2.0.0rc1";

// Package index the SDK is installed from. The SDK currently lives only on
// TestPyPI — this is the single place that changes on the production PyPI
// cutover (a separate, later piece of work owns making that switch).
export const PYTHON_AGENT_SDK_PACKAGE_INDEX_URL = "https://test.pypi.org/simple/";

// ---- TypeScript agent SDK ----

// The npm package generated TypeScript agents depend on. This is the
// install source of truth — scaffolded agents get it via `npm install`,
// not Bun.build vendoring.
export const TS_AGENT_SDK_NPM_PACKAGE = "@novaos/agent-sdk";

// Pinned SDK version range scaffolded into every new TypeScript agent's
// package.json. Bump this when a new pinned version should roll out to
// newly-scaffolded agents.
//
// Unlike PYTHON_AGENT_SDK_VERSION, this package has no registry release at
// all yet, so there is nothing to verify a bump against — this is a
// documented placeholder pin. A freshly scaffolded TypeScript agent's
// `npm install` will not succeed until the SDK is actually published.
export const TS_AGENT_SDK_VERSION_RANGE = "^0.1.0";

// ---- Java agent SDK ----

// The Maven coordinate generated Java agents depend on. This is the install
// source of truth — scaffolded agents get it via a normal `pom.xml`
// dependency, not a vendoring or bundling step (Java never had one).
export const JAVA_AGENT_SDK_GROUP_ID = "ai.orbitron.novaos";
export const JAVA_AGENT_SDK_ARTIFACT_ID = "agent-sdk";

// Pinned SDK version scaffolded into every new Java agent's `pom.xml`.
// Bump this when a new pinned version should roll out to newly-scaffolded
// agents.
//
// Like TS_AGENT_SDK_VERSION_RANGE, this artifact has no Maven Central release
// yet, so there is nothing to verify a bump against — this is a documented
// placeholder pin. A freshly scaffolded Java agent's `mvn install` will not
// succeed until the SDK is actually published there.
export const JAVA_AGENT_SDK_VERSION = "0.1.0";

// ---- Admin Roles ----

export { PLATFORM_ADMIN_ROLES as ADMIN_ROLES } from "@novaos-cli/shared/auth";
