/**
 * novaos-cli — Connector Commands
 *
 * Provides:
 *   novaos-cli connector list [--publisher <name>] [--json] [--no-paginate]
 *   novaos-cli connector init --name <name> --publisher <publisher> [--template <template>] [--spec <path>]
 *   novaos-cli connector publish <manifest-path> [--dry-run] [--json]
 *   novaos-cli connector register <name> --tenant-id <id> --max-tier <tier> [--credential-file <path> | --credential-stdin | --credential KEY=VALUE ...] [--dry-run]
 *
 * Targets connector-host service endpoints.
 *
 * CONNECTOR_HOST_URL — set to override the default in-cluster connector-host address.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GalaxyHttpClient, withRequestId } from "./http-client.js";
import { assertNameIsNotPath, assertNoPathTraversal } from "./init-path.js";
import { parseEnvLines } from "./mcp-manifest.js";
import {
  extractServerHostnames,
  initFromOpenApiSpec,
  parseOpenApiSpec,
  revalidateSsrfAllowedDomainsAtPublish,
} from "./openapi-connector-codegen.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// mcp-ops connector API removed — connector-host is the control plane
const CONNECTOR_REGISTRY_PATH = "/api/v1/connectors";

// Was "/admin/v1/connectors/:name/configure" — no such route exists in connector-host.
// The real, tenant-scoped configure route (routes/connectors/configure.ts) has no
// "admin" prefix at all.
//
// tenant_id is always appended as a query param: a platform:admin caller's JWT
// carries no tenant claim (they act cross-tenant), so configure.prehandler.ts
// requires it explicitly from the query string for that branch — a regular
// tenant-scoped caller's token already carries its own org claim and the route
// never reads this query param on that path, so it's harmless to always send.
const CONFIGURE_PATH = (name: string, tenantId: string) =>
  `/api/v1/connectors/${name}/configure?tenant_id=${encodeURIComponent(tenantId)}`;
// Still a genuine /admin/v1 route (routes/admin/entitlements.ts) — but that route
// requires a platform:admin-scoped token, which the S2S Gateway's tenant-facing
// /connector prefix has no path for today. `connector register`'s entitlement-grant
// step remains unreachable through connectorHostUrl until that gap is closed
// elsewhere; kept as-is (not part of this fix) rather than silently rerouted.
const ADMIN_ENTITLEMENT_PATH = (name: string, tenantId: string) =>
  `/admin/v1/connectors/${name}/entitlements/${tenantId}`;

const MANIFEST_FILENAME = "connector.json";
const DEFAULT_PORT = 3000;
/** Hard cap on pages walked by connectorList — guards against a misbehaving backend cursor never terminating. */
const MAX_LIST_PAGES = 1000;
const PUBLISH_NOT_AVAILABLE_MSG =
  "Connector publishing is not yet available. This command will work once the Connector Registry is deployed.";

/**
 * Base URL for the connector-host service.
 *
 * Override by setting CONNECTOR_HOST_URL in the environment.
 */
const CONNECTOR_HOST_BASE =
  process.env["CONNECTOR_HOST_URL"] ??
  "http://connector-host.novaos-data-plane.svc.cluster.local:3000";

/**
 * Connector-host direct API endpoints.
 * These are used in generated stub code and internal tooling.
 *
 * mcp-ops connector API removed — connector-host is the control plane.
 */
export const CONNECTOR_HOST_ENDPOINTS = {
  configure: (name: string) => `${CONNECTOR_HOST_BASE}/api/v1/connectors/${name}/configure`,
  connect: (name: string) => `${CONNECTOR_HOST_BASE}/connect/${name}`,
  invoke: (name: string, operation: string) =>
    `${CONNECTOR_HOST_BASE}/api/v1/connectors/${name}/${operation}`,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectorListOptions {
  publisher?: string;
  json?: boolean;
  /** Return only the first page instead of walking the full result set. */
  noPaginate?: boolean;
}

export interface ConnectorInitOptions {
  name: string;
  publisher: string;
  template?: string;
  directory?: string;
  /** Path to an OpenAPI 3.x spec file. When provided, triggers codegen mode. */
  spec?: string;
}

export interface ConnectorPublishOptions {
  manifestPath: string;
  /**
   * Publisher this connector is being published under — connector-host
   * checks this against the caller's own publisher ownership/membership, so
   * only someone who actually owns or belongs to `publisher` can claim or
   * modify a connector name under it.
   */
  publisher: string;
  dryRun?: boolean;
  json?: boolean;
  /**
   * Path to the connector's OpenAPI spec — when provided, the SSRF
   * allowlist is re-derived from the spec's current "servers" list and used
   * as the widening baseline instead of connector.json's own declared_egress
   * field. See revalidateSsrfAllowedDomainsAtPublish's doc comment for why
   * that distinction matters: without a spec, this check cannot detect
   * declared_egress being hand-edited to match a widened allowlist.
   */
  specPath?: string;
}

export interface CredentialSchemaField {
  name: string;
  label: string;
  type: "secret" | "string";
  required: boolean;
  description?: string;
}

export interface ConnectorEntry {
  name: string;
  publisher: string;
  version?: string;
  description?: string;
  credentials_schema?: CredentialSchemaField[];
}

export interface ConnectorRegisterOptions {
  connectorName: string;
  tenantId: string;
  maxTier: string;
  /** KEY=VALUE strings from repeated --credential flags. Exposed in argv/ps — prefer credentialFile or credentialStdin. */
  credentials: string[];
  /** Path to a file of KEY=VALUE lines (same format as .env), merged over --credential entries. */
  credentialFile?: string;
  /** Read KEY=VALUE lines from stdin, merged over --credential and credentialFile entries. */
  credentialStdin?: boolean;
  dryRun: boolean;
}

export interface ConnectorRegisterDeps {
  /** Injectable for tests — defaults to reading all of process.stdin. */
  readStdin?: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8"));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export interface ConnectorRegisterResult {
  configured: boolean;
  entitlementGranted: boolean;
  connectorName: string;
  tenantId: string;
  maxTier: string;
}

export interface ConnectorListResult {
  connectors: ConnectorEntry[];
  cursor?: string | null;
  has_more?: boolean;
  /** True when pagination stopped before exhausting the result set (--no-paginate or the MAX_LIST_PAGES cap). */
  truncated?: boolean;
}

export interface ConnectorPublishResult {
  success: boolean;
  message: string;
  connector_id?: string;
}

interface ConnectorRegistryResponse<T> {
  data: T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function isPlatformUnavailable(status: number): boolean {
  return status === 404 || status === 501;
}

// ---------------------------------------------------------------------------
// Scaffold helpers (connector init — stub mode, no --spec)
// ---------------------------------------------------------------------------

function generateConnectorManifest(opts: ConnectorInitOptions): string {
  const manifest = {
    schema_version: "1.0",
    name: opts.name,
    publisher: opts.publisher,
    version: "1.0.0",
    description: `Connector: ${opts.name}`,
    connector_type: "source",
    credentials_schema: [
      {
        name: "api_key",
        label: "API Key",
        type: "secret",
        required: true,
        description: "Your API key",
      },
    ],
    health_check: {
      path: "/health",
      interval_seconds: 30,
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

function generateConnectorSource(name: string): string {
  // Use CONNECTOR_HOST_ENDPOINTS to document the connector-host paths.
  const configureUrl = `\${CONNECTOR_HOST_BASE}/api/v1/connectors/${name}/configure`;
  const connectUrl = `\${CONNECTOR_HOST_BASE}/connect/${name}`;
  const invokeUrl = `\${CONNECTOR_HOST_BASE}/api/v1/connectors/${name}/:operation`;

  return `/**
 * ${name} — Connector entry point.
 *
 * Implements the NovaOS Connector interface.
 *
 * Connector-host endpoints (CONNECTOR_HOST_URL env var or default in-cluster address):
 *   Configure credential: POST ${configureUrl}
 *   OAuth connect:        GET  ${connectUrl}
 *   Invoke operation:     POST ${invokeUrl}
 */

import Fastify from "fastify";

const PORT = Number(process.env.PORT) || ${DEFAULT_PORT};
const CONNECTOR_HOST_BASE =
  process.env.CONNECTOR_HOST_URL ??
  "http://connector-host.novaos-data-plane.svc.cluster.local:3000";

const server = Fastify({ logger: true });

server.get("/health", async () => ({ status: "ok" }));

server.post("/connect", async (request, reply) => {
  const config = request.body as Record<string, unknown>;
  return { connected: true, config_keys: Object.keys(config) };
});

server.post("/sync", async (request, reply) => {
  return { records: [], cursor: null, has_more: false };
});

server.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
});
`;
}

function generateConnectorPackageJson(name: string): string {
  const pkg = {
    name: `connector-${name}`,
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "bun run src/index.ts",
      dev: "bun --watch src/index.ts",
    },
    dependencies: {
      fastify: "5.3.3",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function generateConnectorDockerfile(): string {
  return `FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE ${DEFAULT_PORT}
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:${DEFAULT_PORT}/health || exit 1

CMD ["bun", "run", "src/index.ts"]
`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Fetches one page of the connector registry list. */
async function fetchConnectorListPage(
  client: GalaxyHttpClient,
  opts: ConnectorListOptions,
  cursor: string | undefined
): Promise<
  { platformUnavailable: true } | { platformUnavailable: false; page: ConnectorListResult }
> {
  const params = new URLSearchParams();
  if (opts.publisher) params.set("publisher", opts.publisher);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();

  const response = await client.request<ConnectorRegistryResponse<ConnectorListResult>>(
    `${CONNECTOR_REGISTRY_PATH}${query ? `?${query}` : ""}`
  );

  // Only the first page's 404/501 means "the registry isn't deployed yet" — once a page has
  // already succeeded, the registry is known to be up, so the same status on a later page means
  // the cursor is invalid/unsupported and must fail loudly rather than silently discarding the
  // connectors already collected.
  if (cursor === undefined && isPlatformUnavailable(response.status)) {
    return { platformUnavailable: true };
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to list connectors: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  return { platformUnavailable: false, page: response.data.data };
}

export async function connectorList(
  client: GalaxyHttpClient,
  opts: ConnectorListOptions
): Promise<ConnectorListResult> {
  const connectors: ConnectorEntry[] = [];
  let cursor: string | undefined;
  let truncationReason: "no-paginate" | "page-limit" | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await fetchConnectorListPage(client, opts, cursor);

    if (result.platformUnavailable) {
      const notice =
        "Connector Registry is not yet available. This command will work once the Connector Registry is deployed.";
      if (opts.json) {
        printJson({ connectors: [], notice });
      } else {
        process.stdout.write(`${notice}\n`);
      }
      return { connectors: [] };
    }

    connectors.push(...(result.page.connectors ?? []));

    if (!result.page.has_more || !result.page.cursor) {
      break;
    }

    if (opts.noPaginate) {
      truncationReason = "no-paginate";
      break;
    }

    cursor = result.page.cursor;

    if (page === MAX_LIST_PAGES - 1) {
      // Still has_more/cursor after the last page we're willing to fetch — the result below
      // is a partial view, not the full registry, so it must be flagged as such.
      truncationReason = "page-limit";
    }
  }

  const finalResult: ConnectorListResult = { connectors };
  if (truncationReason !== undefined) {
    finalResult.truncated = true;
  }

  // Truncation is signalled on stderr regardless of --json — machine consumers can also read
  // `truncated` off the returned/printed result itself, but a script piping only stdout to a
  // file would otherwise have no signal at all that the list is incomplete.
  if (opts.json) {
    printJson(finalResult);
  } else if (connectors.length === 0) {
    process.stdout.write("No connectors found.\n");
  } else {
    for (const c of connectors) {
      process.stdout.write(
        `  ${c.publisher}/${c.name}  v${c.version ?? "?"}  ${c.description ?? ""}\n`
      );
    }
  }

  if (truncationReason === "no-paginate") {
    process.stderr.write(
      `Showing ${connectors.length} connector(s) from the first page only (--no-paginate). ` +
        `Re-run without --no-paginate to see all results.\n`
    );
  } else if (truncationReason === "page-limit") {
    process.stderr.write(
      `Stopped after ${MAX_LIST_PAGES} pages (${connectors.length} connector(s)) — more results may exist. ` +
        `This is a safety cap against a runaway cursor; contact platform support if the registry ` +
        `genuinely has more than ${MAX_LIST_PAGES} pages.\n`
    );
  }

  return finalResult;
}

export function connectorInit(opts: ConnectorInitOptions): { directory: string; files: string[] } {
  assertNameIsNotPath("connector", opts.name);

  // When --spec is provided, delegate to the OpenAPI codegen pipeline.
  if (opts.spec) {
    return initFromOpenApiSpec({
      name: opts.name,
      publisher: opts.publisher,
      specPath: opts.spec,
      directory: opts.directory,
    });
  }

  const directory = opts.directory ?? `./${opts.name}`;
  assertNoPathTraversal(directory);

  const targetDir = path.resolve(directory);

  if (existsSync(path.join(targetDir, MANIFEST_FILENAME))) {
    throw new Error(
      `${MANIFEST_FILENAME} already exists in ${targetDir}. Remove it first or choose a different directory.`
    );
  }

  mkdirSync(targetDir, { recursive: true });
  mkdirSync(path.join(targetDir, "src"), { recursive: true });

  writeFileSync(path.join(targetDir, MANIFEST_FILENAME), generateConnectorManifest(opts));
  writeFileSync(path.join(targetDir, "src", "index.ts"), generateConnectorSource(opts.name));
  writeFileSync(path.join(targetDir, "package.json"), generateConnectorPackageJson(opts.name));
  writeFileSync(path.join(targetDir, "Dockerfile"), generateConnectorDockerfile());

  const files = [MANIFEST_FILENAME, "src/index.ts", "package.json", "Dockerfile"];
  return { directory, files };
}

export async function connectorRegister(
  client: GalaxyHttpClient,
  opts: ConnectorRegisterOptions,
  deps?: ConnectorRegisterDeps
): Promise<ConnectorRegisterResult> {
  const { connectorName, tenantId, maxTier, credentials, dryRun } = opts;

  // Step 1 — Parse credential flags into a map. --credential-file and --credential-stdin
  // are layered on top (each overrides same-named keys from the sources before it) since
  // both avoid putting secret values in argv/ps, unlike --credential.
  const credentialsMap: Record<string, string> = {};
  for (const entry of credentials) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(
        `Invalid --credential format: "${entry}". Expected KEY=VALUE (e.g. --credential api_key=sk_live_...)`
      );
    }
    const key = entry.slice(0, eqIdx);
    const value = entry.slice(eqIdx + 1);
    if (!key) {
      throw new Error(`Invalid --credential format: "${entry}". Key must not be empty.`);
    }
    credentialsMap[key] = value;
  }

  if (opts.credentialFile) {
    let fileContent: string;
    try {
      fileContent = readFileSync(path.resolve(opts.credentialFile), "utf-8");
    } catch {
      throw new Error(`Cannot read --credential-file: ${opts.credentialFile}`);
    }
    Object.assign(credentialsMap, parseEnvLines(fileContent));
  }

  if (opts.credentialStdin) {
    const _readStdin = deps?.readStdin ?? readAllStdin;
    const stdinContent = await _readStdin();
    Object.assign(credentialsMap, parseEnvLines(stdinContent));
  }

  // Step 2 — Pre-flight: validate required fields against credentials_schema
  // If the registry is unreachable, skip validation and proceed.
  try {
    const listResponse =
      await client.request<ConnectorRegistryResponse<ConnectorListResult>>(CONNECTOR_REGISTRY_PATH);
    if (listResponse.ok) {
      const connectors = listResponse.data?.data?.connectors ?? [];
      const manifest = connectors.find((c) => c.name === connectorName);
      if (manifest?.credentials_schema) {
        const missingFields = manifest.credentials_schema
          .filter((field) => field.required && !(field.name in credentialsMap))
          .map((field) => field.name);
        if (missingFields.length > 0) {
          throw new Error(
            `Missing required credential field(s) for connector "${connectorName}":\n` +
              missingFields.map((f) => `  --credential ${f}=<value>`).join("\n") +
              `\nRun 'novaos-cli connector list' to see the full credentials_schema.`
          );
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Re-throw validation errors — missing required fields must block all API calls.
    if (msg.startsWith("Missing required credential field")) {
      throw err;
    }
    // Re-throw authentication errors — an unauthenticated session must never silently
    // produce dry-run output or proceed to API calls without a re-login prompt.
    if (msg.includes("auth login")) {
      throw err;
    }
    // All other errors (503, network unreachable, DNS failure, etc.) are non-fatal:
    // the registry may be unavailable but the configure + entitlement endpoints can
    // still succeed independently. Skip pre-flight and proceed.
  }

  // Step 3 — Dry run: print the calls that would be made without executing them.
  // Credential values must never appear in output — key names only.
  if (dryRun) {
    const keyList = Object.keys(credentialsMap).join(", ");
    process.stdout.write("[dry-run] Would call:\n");
    process.stdout.write(
      `  POST ${client.getBaseUrl()}${CONFIGURE_PATH(connectorName, tenantId)}\n`
    );
    process.stdout.write(`  Body: { credentials: { ${keyList} } }\n`);
    process.stdout.write(
      `  PUT ${client.getBaseUrl()}${ADMIN_ENTITLEMENT_PATH(connectorName, tenantId)}\n`
    );
    process.stdout.write(`  Body: { enabled: true, max_tier: "${maxTier}" }\n`);
    return { configured: false, entitlementGranted: false, connectorName, tenantId, maxTier };
  }

  // Step 4 — Configure: store credentials for the connector.
  const configureResp = await client.request<unknown>(CONFIGURE_PATH(connectorName, tenantId), {
    method: "POST",
    headers: { "X-Idempotency-Key": randomUUID() },
    body: { credentials: credentialsMap },
  });
  if (!configureResp.ok) {
    throw new Error(
      withRequestId(
        `Configure failed (${configureResp.status}): ${JSON.stringify(configureResp.data)}\n` +
          `Entitlement was not attempted.`,
        configureResp
      )
    );
  }
  process.stdout.write(`✓ Credentials configured for connector "${connectorName}"\n`);

  // Step 5 — Grant entitlement for the tenant.
  const entitlementResp = await client.request<unknown>(
    ADMIN_ENTITLEMENT_PATH(connectorName, tenantId),
    {
      method: "PUT",
      body: { enabled: true, max_tier: maxTier },
    }
  );
  if (!entitlementResp.ok) {
    throw new Error(
      withRequestId(
        `Entitlement grant failed (${entitlementResp.status}): ${JSON.stringify(entitlementResp.data)}\n` +
          `Credentials were configured successfully. ` +
          `Re-run with the same --credential flags to retry, or grant the entitlement manually:\n` +
          `  PUT ${client.getBaseUrl()}${ADMIN_ENTITLEMENT_PATH(connectorName, tenantId)}\n` +
          `  Body: { enabled: true, max_tier: "${maxTier}" }`,
        entitlementResp
      )
    );
  }
  process.stdout.write(`✓ Entitlement granted for tenant "${tenantId}" at tier "${maxTier}"\n`);
  process.stdout.write(`\nConnector "${connectorName}" registered successfully.\n`);

  return { configured: true, entitlementGranted: true, connectorName, tenantId, maxTier };
}

export async function connectorPublish(
  client: GalaxyHttpClient,
  opts: ConnectorPublishOptions
): Promise<ConnectorPublishResult> {
  let manifestContent: string;
  try {
    manifestContent = readFileSync(opts.manifestPath, "utf-8");
  } catch {
    throw new Error(`Cannot read manifest file: ${opts.manifestPath}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new Error(`Invalid JSON in manifest file: ${opts.manifestPath}`);
  }

  // Sent to the server as `openapi_spec` when --spec is used, so connector-host can
  // independently re-derive the same trust baseline this client-side check just used —
  // without it, the server has no way to distinguish a legitimate --spec-justified
  // widening from an unjustified one, and would reject both with SSRF_ALLOWLIST_WIDENED.
  //
  // Only the `servers` list is sent — never the full parsed document. The server's
  // re-derivation only ever reads `servers` (see extractOpenApiServerHostnames), and a
  // full vendor spec can be tens of MB with deeply nested paths/schemas, risking Fastify's
  // default body-size limit and needlessly wasting bandwidth for data the server ignores.
  let openapiSpec: { servers: unknown[] } | undefined;

  if (typeof manifest === "object" && manifest !== null) {
    const manifestRecord = manifest as Record<string, unknown>;
    let trustedDeclaredEgress: string[] | undefined;
    if (opts.specPath) {
      const spec = parseOpenApiSpec(opts.specPath);
      trustedDeclaredEgress = extractServerHostnames(spec.servers ?? []);
      openapiSpec = { servers: spec.servers ?? [] };
    } else if (
      manifestRecord["ssrf"] ||
      manifestRecord["allowed_domains"] ||
      manifestRecord["declared_egress"]
    ) {
      // Only worth warning about when there's an egress allowlist to re-validate at all —
      // a stub-mode manifest with none of these fields has nothing this check can miss.
      process.stderr.write(
        "Warning: publishing without --spec — the SSRF allowlist re-validation below compares " +
          "connector.json's own fields against each other, which cannot detect declared_egress " +
          "itself being edited to match a widened allowlist. Pass --spec <path> to re-derive a " +
          "trustworthy baseline directly from the connector's OpenAPI spec instead.\n"
      );
    }
    revalidateSsrfAllowedDomainsAtPublish(manifestRecord, { trustedDeclaredEgress });
  }

  const response = await client.request<ConnectorRegistryResponse<ConnectorPublishResult>>(
    `${CONNECTOR_REGISTRY_PATH}/publish`,
    {
      method: "POST",
      body: {
        manifest,
        publisher: opts.publisher,
        dry_run: opts.dryRun ?? false,
        ...(openapiSpec ? { openapi_spec: openapiSpec } : {}),
      },
    }
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({ success: false, notice: PUBLISH_NOT_AVAILABLE_MSG });
    } else {
      process.stderr.write(`${PUBLISH_NOT_AVAILABLE_MSG}\n`);
    }
    return { success: false, message: PUBLISH_NOT_AVAILABLE_MSG };
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to publish connector: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;

  if (opts.json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(
      `Connector published${opts.dryRun ? " (dry run)" : ""}: ${result.message}\n`
    );
  } else {
    process.stderr.write(`Connector publish failed: ${result.message}\n`);
  }

  return result;
}
