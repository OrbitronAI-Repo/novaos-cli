/**
 * Tool-health preflight check — calls connector-host's tool-availability
 * endpoint to verify declared tools are available for the target org.
 */

import { getAccessToken } from "./auth.js";
import { resolveActiveEnvironment, resolveUrls } from "./config.js";

export interface ToolHealthPreflightResult {
  /** The org actually checked, as resolved by connector-host from the caller's own bearer token — may differ from opts.orgId. */
  orgId: string;
  available: string[];
  restricted: string[];
}

export interface ToolHealthPreflightOptions {
  agentId: string;
  version: string;
  orgId: string;
  strictTools?: boolean;
  baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runToolHealthPreflight(
  opts: ToolHealthPreflightOptions
): Promise<ToolHealthPreflightResult> {
  // Same resolution every other CLI command uses (NOVAOS_CONNECTOR_HOST_URL,
  // then the active environment's connectorHostUrl, "local" defaulting to
  // http://localhost:3700) — this used to hard-code the pre-env-overhaul
  // CONNECTOR_HOST_URL var and :3050 default, which no caller (including
  // `sandbox start`, which never passes baseUrl) ever overrode.
  const baseUrl =
    opts.baseUrl ?? resolveUrls((await resolveActiveEnvironment()).name).connectorHostUrl;
  const url = new URL("/health/tool-availability", baseUrl);
  url.searchParams.set("agentId", opts.agentId);
  url.searchParams.set("agentVersion", opts.version);

  // orgId is no longer sent to the server — connector-host derives it from
  // this bearer token's own claims, same as every other authenticated CLI
  // call. opts.orgId is still used by callers for local display/logging.
  const token = await getAccessToken();

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Tool health preflight failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    orgId?: string;
    available?: string[];
    restricted?: string[];
  };

  return {
    orgId: typeof data.orgId === "string" && data.orgId ? data.orgId : opts.orgId,
    available: Array.isArray(data.available) ? data.available : [],
    restricted: Array.isArray(data.restricted) ? data.restricted : [],
  };
}
