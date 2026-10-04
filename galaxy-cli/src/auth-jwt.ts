/**
 * novaos-cli JWT Claim Decoding
 *
 * Unverified decode of ID/access tokens into identity, roles, and
 * organization membership.
 *
 * `decodeJwt` (jose) only base64-decodes the payload — it never verifies the
 * signature. Every caller of these claims is for display/UX (whoami, role
 * hints, org resolution) or for the local, non-authoritative RBAC checks
 * documented on `RBAC_LOCAL_CHECK_DISCLAIMER` in `./auth-rbac.js`. Do not
 * start trusting these claims for anything security-relevant without adding
 * real verification.
 */

import { decodeJwt } from "jose";

import type { StoredCredentials } from "./auth-credentials.js";
import { ROLES_CLAIM_PATHS } from "./constants.js";

export interface AuthIdentity {
  subject: string;
  email?: string;
  name?: string;
  tenant_id?: string;
  org_id?: string;
  /** Present on org-scoped access tokens (Logto organization_id claim). */
  organization_id?: string;
  /** Membership list from ID token `organizations` claim. */
  organizations?: string[];
  publisher_name?: string;
  publisher_id?: string;
  roles?: string[];
  expires_at: number;
  expires_at_iso: string;
  token_status: "valid" | "expired";
}

export function extractRoles(claims: Record<string, unknown>): string[] | undefined {
  for (const path of ROLES_CLAIM_PATHS) {
    const value = claims[path];
    if (Array.isArray(value)) return value as string[];
  }
  return undefined;
}

export function extractProfileFromIdToken(idToken: string): { email?: string; name?: string } {
  try {
    const claims = decodeJwt(idToken);
    return {
      email: typeof claims.email === "string" ? claims.email : undefined,
      name: typeof claims.name === "string" ? claims.name : undefined,
    };
  } catch {
    return {};
  }
}

export function extractOrganizationsFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.organizations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function extractOrganizationIdFromClaims(
  claims: Record<string, unknown>
): string | undefined {
  const value = claims.organization_id ?? claims.org_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `decodeJwt` (jose) only base64-decodes the payload — it never verifies the
 * signature. Every caller of these claims is for display/UX (whoami, role hints,
 * org resolution) or for the local, non-authoritative RBAC checks documented on
 * `RBAC_LOCAL_CHECK_DISCLAIMER` in `./auth-rbac.js`. Do not start trusting these
 * claims for anything security-relevant without adding real verification.
 */
export function safeDecodeClaims(token: string): Record<string, unknown> {
  try {
    return decodeJwt(token) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function membershipsFromCredentials(credentials: StoredCredentials): string[] {
  if (credentials.id_token) {
    const fromId = extractOrganizationsFromClaims(safeDecodeClaims(credentials.id_token));
    if (fromId.length > 0) return fromId;
  }
  return extractOrganizationsFromClaims(safeDecodeClaims(credentials.access_token));
}

export function decodeIdentity(credentials: StoredCredentials): AuthIdentity {
  const idClaims = credentials.id_token ? safeDecodeClaims(credentials.id_token) : {};
  const accessClaims = safeDecodeClaims(credentials.access_token);
  // Profile/roles often live on the ID token; org tenant claims live on the access token.
  const organizationId =
    extractOrganizationIdFromClaims(accessClaims) ?? extractOrganizationIdFromClaims(idClaims);
  const organizations = membershipsFromCredentials(credentials);
  const roles = credentials.id_token ? extractRoles(idClaims) : extractRoles(accessClaims);
  const subject =
    (typeof accessClaims.sub === "string" && accessClaims.sub) ||
    (typeof idClaims.sub === "string" && idClaims.sub) ||
    "unknown";

  const tenantFromClaim =
    (typeof accessClaims.tenant_id === "string" && accessClaims.tenant_id) ||
    (typeof idClaims.tenant_id === "string" && idClaims.tenant_id) ||
    undefined;

  const now = Math.floor(Date.now() / 1000);
  const isExpired = credentials.expires_at <= now;

  return {
    subject,
    email:
      (typeof idClaims.email === "string" && idClaims.email) ||
      (typeof accessClaims.email === "string" && accessClaims.email) ||
      credentials.email,
    name:
      (typeof idClaims.name === "string" && idClaims.name) ||
      (typeof accessClaims.name === "string" && accessClaims.name) ||
      credentials.name,
    tenant_id: tenantFromClaim ?? organizationId,
    org_id:
      (typeof accessClaims.org_id === "string" && accessClaims.org_id) ||
      (typeof idClaims.org_id === "string" && idClaims.org_id) ||
      organizationId,
    organization_id: organizationId,
    organizations: organizations.length > 0 ? organizations : undefined,
    publisher_name:
      (typeof idClaims.publisher_name === "string" && idClaims.publisher_name) ||
      (typeof accessClaims.publisher_name === "string" && accessClaims.publisher_name) ||
      undefined,
    publisher_id:
      (typeof idClaims.publisher_id === "string" && idClaims.publisher_id) ||
      (typeof accessClaims.publisher_id === "string" && accessClaims.publisher_id) ||
      undefined,
    roles,
    expires_at: credentials.expires_at,
    expires_at_iso: new Date(credentials.expires_at * 1000).toISOString(),
    token_status: isExpired ? "expired" : "valid",
  };
}
