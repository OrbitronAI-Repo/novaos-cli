/**
 * Platform admin roles / scopes — single source of truth.
 * Split from auth/index so auth-middleware can import without colliding with
 * bun:test mock.module("@novaos-cli/shared/auth") (barrel).
 */

export const PLATFORM_ADMIN_ROLES = ["admin", "novaos-admin", "platform-admin"] as const;

/**
 * Resource-scope that grants platform admin for M2M (client_credentials) tokens.
 * Marketplace BFF mints tokens with this scope after requireAdmin(); downstream
 * services must accept it via requireAdminRole (roles OR this scope).
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
 * Used for M2M BFF→service hops where the access token has no role claims.
 */
export function hasPlatformAdminScope(scopes: string[] | undefined): boolean {
  if (!scopes?.length) return false;
  const needle = PLATFORM_ADMIN_SCOPE.toLowerCase();
  return scopes.some((s) => s.toLowerCase() === needle);
}

/**
 * Platform admin via JWT roles OR M2M `platform:admin` scope.
 * Prefer this (or requireAdminRole) over isPlatformAdmin(roles) alone on
 * AuthContext gates — M2M tokens from the admin BFF have scopes, not roles.
 */
export function hasPlatformAdminAccess(
  roles: string[] | undefined,
  scopes: string[] | undefined
): boolean {
  return isPlatformAdmin(roles) || hasPlatformAdminScope(scopes);
}
