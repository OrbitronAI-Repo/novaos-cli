/**
 * Platform admin roles / scopes — single source of truth.
 * Split from auth/index so auth-middleware can import without colliding with
 * bun:test mock.module("@novaos-cli/shared/auth") (barrel).
 */

export const PLATFORM_ADMIN_ROLES = ["admin", "novaos-admin", "platform-admin"] as const;

/**
 * Resource-scope that grants platform admin for tokens that carry scopes but
 * no role claims: Logto M2M (client_credentials) apps that hold it through an
 * M2M role on the `urn:novaos` resource, and operator-supplied service tokens
 * (for example the connector-host admin token). No service in this repo mints it
 * on demand. Downstream services must accept it via requireAdminRole (roles OR
 * this scope).
 */
export const PLATFORM_ADMIN_SCOPE = "platform:admin" as const;

/** Case-insensitive check against PLATFORM_ADMIN_ROLES. */
export function isPlatformAdmin(roles: string[] | undefined): boolean {
  if (!roles?.length) return false;
  const lower = roles.map((r) => r.toLowerCase());
  return PLATFORM_ADMIN_ROLES.some((r) => lower.includes(r));
}

/**
 * True when scopes include `platform:admin` (case-insensitive).
 * Used for service-to-service tokens (M2M apps, operator-supplied tokens) whose
 * access token has no role claims.
 */
export function hasPlatformAdminScope(scopes: string[] | undefined): boolean {
  if (!scopes?.length) return false;
  const needle = PLATFORM_ADMIN_SCOPE.toLowerCase();
  return scopes.some((s) => s.toLowerCase() === needle);
}

/**
 * Platform admin via JWT roles OR M2M `platform:admin` scope.
 * Prefer this (or requireAdminRole) over isPlatformAdmin(roles) alone on
 * AuthContext gates — M2M and operator-supplied service tokens have scopes, not
 * roles.
 */
export function hasPlatformAdminAccess(
  roles: string[] | undefined,
  scopes: string[] | undefined
): boolean {
  return isPlatformAdmin(roles) || hasPlatformAdminScope(scopes);
}
