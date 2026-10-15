/**
 * IP-range classification helpers (pure — no Node built-ins, safe in any bundle).
 *
 * Single source of truth inside `shared` for "is this address private /
 * loopback / link-local / metadata-reachable". Used by the registry-URL SSRF
 * guard in utils and by the REST endpoint guard.
 */

export function isValidIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255 && part === String(n);
  });
}

/** Returns true if the address is a private/loopback/link-local IPv4 literal. */
export function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    // CGNAT shared address space, RFC 6598 (100.64.0.0/10) — reachable from
    // inside cloud networks (e.g. Alibaba Cloud's metadata endpoint
    // 100.100.100.200) even though it's not RFC1918. The connector host's
    // SSRF guard needs the same range blocked.
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0
  );
}

/** Returns true if the address is a private/loopback/link-local/unique-local IPv6 literal. */
export function isPrivateIPv6(address: string): boolean {
  const a = address.toLowerCase();

  if (a === "::1" || a === "::" || a === "0:0:0:0:0:0:0:0" || a === "0:0:0:0:0:0:0:1") {
    return true;
  }

  // Unique local (RFC 4193) fc00::/7 — covers AWS's IPv6 IMDS address fd00:ec2::254.
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;

  // Link-local fe80::/10.
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;

  // IPv4-mapped (::ffff:x.x.x.x) and NAT64 (64:ff9b::/96) addresses both embed
  // a full IPv4 address in their last 32 bits (dotted or hex-group form — the
  // WHATWG/Node resolver can return either). Decode it and recheck as IPv4,
  // otherwise a private IPv4 could be smuggled through an IPv6 wrapper.
  const embeddedV4 = extractEmbeddedIPv4(a);
  if (embeddedV4 && isPrivateIPv4(embeddedV4)) return true;

  return false;
}

/** Extracts the IPv4 address embedded in an IPv4-mapped or NAT64 IPv6 literal, if any. */
function extractEmbeddedIPv4(address: string): string | null {
  const PREFIX = "(?:::ffff:|64:ff9b::)";

  const dotted = address.match(new RegExp(`^${PREFIX}(\\d+\\.\\d+\\.\\d+\\.\\d+)$`));
  if (dotted?.[1] && isValidIPv4(dotted[1])) return dotted[1];

  const hex = address.match(new RegExp(`^${PREFIX}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`));
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }

  return null;
}
