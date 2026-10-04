/**
 * novaos-cli Local RBAC Checks
 *
 * `roles` here always comes from `decodeJwt()` / `safeDecodeClaims()` (see
 * `./auth-jwt.js`), which only base64-decodes the JWT payload and never
 * verifies its signature. That means `hasRole`, and the
 * `assertDeveloperRole`/`assertPlatformAdmin` guards built on it, are local,
 * non-authoritative UX conveniences only — a hand-edited
 * `~/.novaos/credentials.json` with a self-signed `alg:none` token can make
 * any of these checks pass.
 *
 * This is intentional, not a bug to fix by adding client-side signature
 * verification: every command gated by these checks immediately makes an
 * authenticated network call (agent-ops/mcp-ops/gateway/marketplace) using
 * the same bearer token, and it is that server-side verification — not this
 * local check — that is the actual RBAC enforcement boundary. A forged token
 * fails there regardless of what it claims locally. These local checks exist
 * purely to fail fast with a friendly message before making a network
 * round-trip that would otherwise 401/403.
 */

import { isPlatformAdmin, PLATFORM_ADMIN_ROLES } from "@novaos-cli/shared/auth";

import type { AuthIdentity } from "./auth-jwt.js";
import { REQUIRED_CLI_ROLE } from "./constants.js";

export const RBAC_LOCAL_CHECK_DISCLAIMER =
  "(This is a local check against unverified token claims, shown for a fast, friendly " +
  "error only — NovaOS independently enforces this role requirement server-side on " +
  "every request, so it cannot be bypassed by editing local credentials.)";

export function hasRole(roles: string[] | undefined, target: string): boolean {
  if (!roles) return false;
  const lowerTarget = target.toLowerCase();
  return roles.some((r) => r.toLowerCase() === lowerTarget);
}

/**
 * Throws a friendly error when `identity` lacks REQUIRED_CLI_ROLE. See the
 * module-level disclaimer above — this is a local, non-authoritative UX gate.
 */
export function assertDeveloperRole(identity: AuthIdentity): void {
  if (!hasRole(identity.roles, REQUIRED_CLI_ROLE)) {
    throw new Error(
      `Your account lacks the '${REQUIRED_CLI_ROLE}' role required for this command.\n` +
        `Current roles: ${identity.roles?.join(", ") || "none"}\n` +
        `Request the developer role from your workspace admin.\n` +
        RBAC_LOCAL_CHECK_DISCLAIMER
    );
  }
}

/**
 * Throws a friendly error when `identity` lacks a platform admin role. See
 * the module-level disclaimer above — this is a local, non-authoritative UX
 * gate.
 */
export function assertPlatformAdmin(identity: AuthIdentity): void {
  if (!isPlatformAdmin(identity.roles)) {
    throw new Error(
      `This command requires a platform admin role (${PLATFORM_ADMIN_ROLES.join(", ")}).\n` +
        `Current roles: ${identity.roles?.join(", ") || "none"}\n` +
        `Contact your workspace administrator for elevated access.\n` +
        RBAC_LOCAL_CHECK_DISCLAIMER
    );
  }
}
