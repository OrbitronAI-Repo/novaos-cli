/**
 * Single source of truth for the CLI's agent "protocol" (adapter selector, not a
 * wire protocol — mirrors the platform-wide routing predicate in
 * `@novaos-cli/shared/adapter-type`, which governs already-published
 * agents' stored values and is out of scope here) input handling.
 *
 * ACP is not supported going forward — A2A only, permanently, not a migration
 * waypoint. New agent scaffolding (`novaos-cli init --protocol ACP`) is rejected
 * outright with an explicit error. An existing manifest file that already has
 * `protocol: "ACP"` (scaffolded under the old rule) still parses — rejecting
 * it would break every agent created before this change — but new input is
 * never coerced or silently accepted.
 *
 * agent-init.ts, manifest.ts, and cli.ts all defer to this module instead of
 * each re-implementing the alias check.
 */

/** Values a NEW agent may be scaffolded with. */
export const NEW_AGENT_PROTOCOLS = ["A2A", "REST"] as const;
export type NewAgentProtocol = (typeof NEW_AGENT_PROTOCOLS)[number];

/** Values an existing manifest file may already contain (includes the legacy ACP alias). */
export const MANIFEST_PROTOCOL_VALUES = ["A2A", "ACP", "REST"] as const;
export type ManifestProtocolValue = (typeof MANIFEST_PROTOCOL_VALUES)[number];

export class UnsupportedProtocolError extends Error {
  constructor(input: string) {
    super(
      `--protocol "${input}" is not supported: ACP is not supported going forward — ` +
        `use --protocol A2A (the default) instead.`
    );
    this.name = "UnsupportedProtocolError";
  }
}

function isAcpAlias(value: string): boolean {
  return value.trim().toUpperCase() === "ACP";
}

/**
 * Resolves and validates a user-supplied --protocol value for NEW agent
 * scaffolding. Throws UnsupportedProtocolError for "ACP" (any case) — this is
 * the one place that decision is enforced.
 */
export function resolveNewAgentProtocol(input: string | undefined): NewAgentProtocol {
  if (!input) {
    return "A2A";
  }
  const normalized = input.trim().toUpperCase();
  if (isAcpAlias(normalized)) {
    throw new UnsupportedProtocolError(input);
  }
  if (normalized === "A2A" || normalized === "REST") {
    return normalized;
  }
  throw new Error(
    `Unknown --protocol "${input}". Valid values: ${NEW_AGENT_PROTOCOLS.join(", ")}.`
  );
}

/** True when a manifest's persisted protocol value is the deprecated ACP alias. */
export function isLegacyAcpProtocolValue(value: string | undefined | null): boolean {
  return typeof value === "string" && isAcpAlias(value);
}
