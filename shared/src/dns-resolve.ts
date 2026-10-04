/**
 * Thin wrapper around Node's DNS resolver.
 *
 * Exists as a separate module (rather than calling `node:dns/promises`
 * directly from the shared utils module) purely so tests can mock it — a real DNS
 * lookup for a fixture hostname like "affirmations-mcp" would otherwise
 * make SSRF tests network-dependent and non-deterministic. The connector
 * host's SSRF guard uses the same wrapper pattern.
 */

import dns from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves every A/AAAA record for `hostname`. Throws if resolution fails. */
export async function resolveHostAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}
