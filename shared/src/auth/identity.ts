/**
 * Canonical tenant/principal identity extraction for rate limiting.
 *
 * Pure claim parsers only — no Redis SA lookup (that stays in gateway iam-sdk).
 *
 * Logto SA shape-based classification (sub === client_id) is for post-auth identity
 * only — after iam-sdk has validated the token. Do not use pre-auth for rate limiting
 * or authorization decisions.
 */

export type ActorType = "user" | "service_account";

export interface ResolvedIdentity {
  subjectId: string;
  tenantId: string;
  orgId?: string;
  actorType: ActorType;
  principalId: string | null;
}

/** Org-level rate-limit principal sentinel (tenant_rate_limit_config PK). */
export const ORG_DEFAULT_PRINCIPAL_ID = "__default__";

/** Resolve Redis/config principal key; org-level quota uses {@link ORG_DEFAULT_PRINCIPAL_ID}. */
export function resolveRateLimitPrincipalId(principalId: string | null): string {
  return principalId ?? ORG_DEFAULT_PRINCIPAL_ID;
}

const LOGTO_TENANT_CLAIM = "https://logto.io/claims/tenantId";
const LOGTO_ORG_CLAIM = "https://logto.io/claims/organizationId";

function claimString(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractOrgId(claims: Record<string, unknown>): string | undefined {
  return (
    claimString(claims, "organization_id") ??
    claimString(claims, "org_id") ??
    claimString(claims, "orgId") ??
    claimString(claims, LOGTO_ORG_CLAIM)
  );
}

function extractExplicitTenantId(claims: Record<string, unknown>): string | undefined {
  return (
    claimString(claims, "tenant_id") ??
    claimString(claims, "tenantId") ??
    claimString(claims, LOGTO_TENANT_CLAIM)
  );
}

/**
 * Shape-based actor resolution for Logto claims (no sa:registered lookup).
 * M2M client_credentials tokens have sub === client_id; user tokens do not.
 *
 * Use only after iam-sdk auth — not for pre-auth classification.
 */
function resolveLogtoActor(
  subjectId: string,
  claims: Record<string, unknown>
): Pick<ResolvedIdentity, "actorType" | "principalId"> {
  const clientId = claimString(claims, "client_id");
  if (clientId && clientId === subjectId) {
    return { actorType: "service_account", principalId: clientId };
  }
  return { actorType: "user", principalId: null };
}

/**
 * Extract canonical identity from Logto JWT / introspection claims.
 * Tenant fallback: tenant_id → tenantId → Logto tenant claim → org_id variants → subjectId.
 */
export function extractFromLogtoClaims(claims: Record<string, unknown>): ResolvedIdentity {
  const subjectId = claimString(claims, "sub");
  if (!subjectId) {
    throw new Error("Logto claims missing subject (sub)");
  }

  const orgId = extractOrgId(claims);
  const explicitTenantId = extractExplicitTenantId(claims);
  const tenantId = explicitTenantId ?? orgId ?? subjectId;
  const { actorType, principalId } = resolveLogtoActor(subjectId, claims);

  return {
    subjectId,
    tenantId,
    ...(orgId !== undefined ? { orgId } : {}),
    actorType,
    principalId,
  };
}

/**
 * Extract canonical identity from execution-scoped delegation token claims.
 * Subject: user_id || sub. Actor/principal from v2 SA claims when present.
 */
export function extractFromExecutionClaims(claims: Record<string, unknown>): ResolvedIdentity {
  const subjectId = claimString(claims, "user_id") ?? claimString(claims, "sub");
  if (!subjectId) {
    throw new Error("Execution claims missing subject (user_id or sub)");
  }

  const tenantId = claimString(claims, "tenant_id");
  if (!tenantId) {
    throw new Error("Execution claims missing tenant_id");
  }

  const rawActorType = claims.actor_type;
  const actorType: ActorType = rawActorType === "service_account" ? "service_account" : "user";

  let principalId: string | null = null;
  if (actorType === "service_account") {
    principalId = claimString(claims, "principal_id") ?? null;
    if (!principalId) {
      throw new Error("Execution claims missing principal_id for service_account actor");
    }
  }

  return {
    subjectId,
    tenantId,
    actorType,
    principalId,
  };
}
