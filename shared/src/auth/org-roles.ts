/**
 * Logto organization (tenant) roles for human users — single source of truth.
 *
 * Every NovaOS tenant is its own Logto organization; these roles are assigned
 * per user *per tenant* and surface in the `organization_roles` JWT claim as
 * `"<orgId>:<role>"`. They are unrelated to the global Logto roles
 * (`platform-admin`, `developer`, `user`) and to the M2M org roles used by
 * service accounts.
 *
 * - Org admin (Manage)  = `owner` | `tenant-admin` — equal admin rights.
 * - Org builder (Build) = `owner` | `developer`.
 * - `member`            = uses agents only; no Org Console access.
 */

export const ORG_ROLE_NAMES = ["owner", "tenant-admin", "developer", "member"] as const;

export type OrgRoleName = (typeof ORG_ROLE_NAMES)[number];

/**
 * Shape check for ANY Logto org role name a platform admin may assign — the
 * four core roles above plus app-defined template roles (e.g. an app's
 * `compliance_analyst`). Existence and User-type are enforced server-side
 * against Logto; this only rejects path-unsafe or absurd input.
 */
export const ORG_ROLE_NAME_MAX_LENGTH = 128;
// eslint-disable-next-line no-control-regex
export const ORG_ROLE_NAME_PATTERN = /^[^/\\\u0000-\u001f\u007f]+$/;

export function isOrgRoleNameShape(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= ORG_ROLE_NAME_MAX_LENGTH &&
    trimmed === name &&
    ORG_ROLE_NAME_PATTERN.test(name)
  );
}

export const ORG_ADMIN_ROLES = ["owner", "tenant-admin"] as const satisfies readonly OrgRoleName[];

export const ORG_BUILD_ROLES = ["owner", "developer"] as const satisfies readonly OrgRoleName[];

function hasAnyRole(roles: readonly string[] | undefined, wanted: readonly string[]): boolean {
  if (!roles?.length) return false;
  return roles.some((r) => wanted.includes(r.toLowerCase()));
}

/** True when the (active-org-filtered) roles include `owner` or `tenant-admin`. */
export function isOrgAdmin(roles: readonly string[] | undefined): boolean {
  return hasAnyRole(roles, ORG_ADMIN_ROLES);
}

/** True when the (active-org-filtered) roles include `owner` or `developer`. */
export function isOrgBuilder(roles: readonly string[] | undefined): boolean {
  return hasAnyRole(roles, ORG_BUILD_ROLES);
}
