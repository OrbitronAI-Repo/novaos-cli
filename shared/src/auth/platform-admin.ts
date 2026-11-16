/**
 * Platform admin roles / scopes — single source of truth.
 * Split from auth/index so auth-middleware can import without colliding with
 * bun:test mock.module("@novaos-cli/shared/auth") (barrel).
 */

/**
 * Global Logto role(s) that make a user a platform admin. The legacy aliases
 * `admin` and `novaos-admin` were removed: no seed script creates them and no
 * tenant (dev, staging-us, staging-eu) has them. Organization admins are the
 * org roles in ORG_ADMIN_ROLES (`owner`, `tenant-admin`), never platform admins.
 */
export const PLATFORM_ADMIN_ROLES = ["platform-admin"] as const;

/**
 * Resource-scope that grants platform admin for tokens that carry scopes but
 * no role claims: Logto M2M (client_credentials) apps that hold it through an
 * M2M role on the `urn:novaos` resource, and operator-supplied service tokens
 * (for example the connector-host admin token). No service in this repo mints it
 * on demand. Downstream services must accept it via requireAdminRole (roles OR
 * this scope).
 *
 * The scope counts ONLY on a token that is not organization-scoped (no
 * `organization_id`): org-scoped Logto tokens get their scopes from organization
 * roles (org owner / tenant-admin, service-account org roles), which must never
 * grant platform admin. Same guard as `is_platform_admin` in
 * infra/opa/bundles/novaos/authz.rego.
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
 * Pure scope test — it ignores the org guard. For an authorization decision use
 * hasPlatformAdminAccess, or check `!orgId` alongside this.
 */
export function hasPlatformAdminScope(scopes: string[] | undefined): boolean {
  if (!scopes?.length) return false;
  const needle = PLATFORM_ADMIN_SCOPE.toLowerCase();
  return scopes.some((s) => s.toLowerCase() === needle);
}

/**
 * Platform admin via JWT roles OR the `platform:admin` scope on a token that is
 * not organization-scoped. Prefer this (or requireAdminRole) over
 * isPlatformAdmin(roles) alone on AuthContext gates — M2M and operator-supplied
 * service tokens have scopes, not roles.
 *
 * `orgId` is the token's `organization_id` (AuthContext.orgId) — never a
 * tenantId. It is required positionally so every caller states it; pass
 * `undefined` only when the token genuinely has none. Empty string = not
 * org-scoped.
 */
export function hasPlatformAdminAccess(
  roles: string[] | undefined,
  scopes: string[] | undefined,
  orgId: string | undefined
): boolean {
  return isPlatformAdmin(roles) || (!orgId && hasPlatformAdminScope(scopes));
}
