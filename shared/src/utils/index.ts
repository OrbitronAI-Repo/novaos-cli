/**
 * Shared utilities
 */

import { createHash } from "crypto";

import { z } from "zod";

import { resolveHostAddresses } from "../dns-resolve.js";
import { isPrivateIPv4, isPrivateIPv6, isValidIPv4 } from "../ip-ranges.js";
import { ValidationError } from "../types/index.js";

/**
 * Removes trailing slashes from a base URL so path segments can be appended
 * without `//` (common pattern for service env vars that may include a
 * trailing slash).
 *
 * Implemented without a regex to avoid ReDoS on attacker-controlled input
 * (a `X+$` pattern on library input is flagged by static analysis).
 */
export function stripTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end--;
  }
  return end === url.length ? url : url.slice(0, end);
}

// ---- Deterministic tenant ID → UUID v5 mapping ----

/**
 * Fixed namespace UUID for deriving tenant UUIDs from external identity
 * provider IDs (e.g. Logto org IDs). Changing this value would remap
 * every tenant to a different UUID — never change it.
 */
const TENANT_NAMESPACE_UUID = "7f3b5c2a-8d1e-4f9a-b6c3-d5e8f7a2b1c4";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUuid(buf: Buffer): string {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Derive a deterministic UUID v5 from an arbitrary tenant ID string
 * (e.g. a Logto org_id like "hgpco4g0jooh").
 *
 * If the input is already a valid UUID, it is returned as-is.
 */
export function tenantIdToUuid(tenantId: string): string {
  if (UUID_RE.test(tenantId)) return tenantId.toLowerCase();

  const nsBytes = parseUuidBytes(TENANT_NAMESPACE_UUID);
  const nameBytes = Buffer.from(tenantId, "utf8");
  // SHA-1 is RFC 4122 §4.3's mandated algorithm for UUID v5, not a
  // security-context hash: not used for authentication, secrets, or
  // signatures, only deterministic ID derivation. Swapping algorithms would
  // remap every already-derived tenant UUID in production, the same class
  // of break the comment on TENANT_NAMESPACE_UUID above already warns
  // against for changing the namespace value.
  // codeql[js/weak-cryptographic-algorithm]
  const hash = createHash("sha1").update(nsBytes).update(nameBytes).digest();

  // RFC 4122 §4.3 — set version (5) and variant (10xx)
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  return formatUuid(hash.subarray(0, 16));
}

/**
 * Type-safe environment variable validation
 */
export function validateEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid environment variables: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Type guard for unknown values
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Guard: assert that a string ID is non-empty.
 * Throws a ValidationError when the value is falsy or blank.
 */
export function requireId(
  value: string | undefined | null,
  paramName: string
): asserts value is string {
  if (!value || !value.trim()) {
    throw new ValidationError(`${paramName} must be a non-empty string`);
  }
}

/**
 * Safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

/**
 * Diagnostic error-to-string extraction for CLI/log output.
 *
 * Prefer this over `getErrorMessage` when the caller wants to preserve the
 * full surface of a thrown non-Error (objects, numbers, undefined) rather
 * than collapsing to a generic `"Unknown error"` label.
 *
 * - `Error`  -> `error.message`
 * - `string` -> the value itself
 * - other    -> `String(error)` (falls back to `"Unknown error"` if `String`
 *               throws for an exotic object)
 */
export function stringifyError(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

export {
  sanitizeK8sLabelValue,
  isValidK8sLabelValue,
  K8S_LABEL_VALUE_MAX_LENGTH,
} from "../k8s-label.js";

// Re-exported for callers already importing from this module; import from the
// shared adapter-type module directly in browser-bundled code, since this
// module pulls in "crypto" and DNS resolution at module scope.
export { isSdkAdapter, isRestAdapter } from "../adapter-type.js";

// ---- SSRF guard for registry-sourced URLs ----

/** Cloud metadata endpoints — must always be blocked. Mirrors the REST adapter's security guard. */
const SSRF_BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254", // AWS / GCP / Azure / DigitalOcean IMDS
  "metadata.google.internal",
  "metadata.azure.com",
  "fd00:ec2::254", // AWS IPv6 IMDS
]);

const SSRF_LINK_LOCAL_PREFIX = "169.254.";

/**
 * True for hostnames that only ever resolve through a private, first-party
 * search-domain DNS server (Kubernetes/Docker/Consul service discovery,
 * `/etc/hosts`) — never through public DNS. These aren't a DNS-rebinding
 * target: rebinding requires an attacker to control the DNS records for the
 * hostname, which is only possible for a real, publicly-registered domain.
 * A bare service name like `affirmations-mcp`, or a Kubernetes-style
 * in-cluster service FQDN, is expected to resolve to a private
 * ClusterIP/bridge address by design — that's normal in-cluster DNS, not a
 * rebind.
 */
function isInternalServiceHostname(hostname: string): boolean {
  // A DNS label can never contain a colon — anything with one is an IPv6
  // literal (dotted-quad-free forms like "fc00::1" or hex-mapped
  // "::ffff:a00:1" have no "." either), not a bare service name. Those are
  // handled by the resolve-then-check-IP step itself, which must not be
  // skipped for them.
  if (!hostname.includes(".") && !hostname.includes(":")) return true; // single DNS label — internal-only
  return (
    /\.svc(\.cluster\.local)?$/.test(hostname) ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".consul")
  );
}

function isLocalOrDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname === "host.docker.internal" ||
    isInternalServiceHostname(hostname)
  );
}

/**
 * Resolves `hostname` and returns true if any returned address is private,
 * loopback, link-local, or unique-local — the resolve-then-check-IP step
 * (the connector host's SSRF guard does the same). Fails closed
 * (returns true, i.e. "blocked") if resolution itself fails — a target this
 * function can't verify is safe is not treated as safe.
 */
async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  let addresses: Awaited<ReturnType<typeof resolveHostAddresses>>;
  try {
    addresses = await resolveHostAddresses(hostname);
  } catch {
    return true;
  }
  return addresses.some(({ address, family }) =>
    family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address)
  );
}

/**
 * Blocks cloud metadata endpoints and RFC1918/loopback IP literals in a
 * registry-sourced URL (MCP service URLs, agent-DNS URLs) before it is
 * dispatched to. Hostname-based internal service names (e.g.
 * "http://affirmations-mcp:8080") are unaffected by the literal/metadata
 * checks — only IP literals and known metadata hostnames are blocked there.
 *
 * Also resolves the hostname and re-checks the addresses it resolves to
 * right now (resolve-then-check-IP) — a hostname can be a clean
 * public IP when first registered and rebound to a private/metadata IP
 * later, and every consumer of this function (the MCP gateway's service
 * client, the agent DNS proxy) already re-calls it on every request, not
 * just at registration, specifically so a change like that gets caught —
 * except the string-only checks above can never catch a *rebind*, since the
 * hostname string itself never changes. This closes that gap. Skipped for
 * localhost/*.local/host.docker.internal, which resolve to loopback by
 * definition and aren't a remote target someone else controls DNS for.
 */
export async function assertNoSSRFTarget(
  url: string,
  opts: { requireHttps?: boolean } = {}
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Invalid URL: ${url}`, "INVALID_URL");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocal = isLocalOrDevHost(hostname);

  if (opts.requireHttps && parsed.protocol !== "https:" && !isLocal) {
    throw new ValidationError(
      `Only HTTPS URLs are allowed (HTTP allowed for localhost only). Got: ${url}`,
      "HTTPS_ONLY_REQUIRED"
    );
  }

  if (SSRF_BLOCKED_METADATA_HOSTS.has(hostname) || hostname.startsWith(SSRF_LINK_LOCAL_PREFIX)) {
    throw new ValidationError(
      `Cloud metadata endpoints are not allowed as a target. Got: ${url}`,
      "SSRF_METADATA_BLOCKED"
    );
  }

  if (isValidIPv4(hostname) && isPrivateIPv4(hostname)) {
    throw new ValidationError(
      `Private/loopback IP literals are not allowed as a target. Got: ${url}`,
      "SSRF_PRIVATE_IP_BLOCKED"
    );
  }

  if (!isLocal && (await resolvesToPrivateAddress(hostname))) {
    throw new ValidationError(
      `Target resolves to a private/internal IP address — blocked to prevent SSRF via DNS rebinding. Got: ${url}`,
      "SSRF_PRIVATE_IP_BLOCKED"
    );
  }
}
