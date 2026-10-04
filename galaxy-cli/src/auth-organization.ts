/**
 * novaos-cli Organization-Selection Policy
 *
 * Resolves the effective active organization from a configured value plus
 * JWT membership claims.
 */

/** Persists CLI active organization (mirrors Marketplace novaos_active_org_id). */
export interface OrganizationContextStore {
  /** Effective org: env override (NOVAOS_ORGANIZATION_ID) or config file. */
  getActiveOrganizationId(): Promise<string | undefined>;
  /**
   * Config-file value only (ignores env). Used so invalid env overrides do not
   * re-trigger auto-select persist/print on every token fetch.
   */
  getPersistedOrganizationId?(): Promise<string | undefined>;
  setActiveOrganizationId(organizationId: string | undefined): Promise<void>;
}

/**
 * Mirrors Marketplace `resolveExecutionTenant`:
 * configured org if valid membership; otherwise first org.
 * When the JWT has no organizations claim, trust an explicitly configured org
 * (config file / NOVAOS_ORGANIZATION_ID) so refresh can still request organization_id.
 */
export function resolveActiveOrganization(input: {
  configuredOrganizationId: string | undefined;
  memberships: readonly string[];
}): { organizationId: string | undefined; autoSelected: boolean } {
  const { configuredOrganizationId, memberships } = input;
  if (memberships.length === 0) {
    return {
      organizationId: configuredOrganizationId,
      autoSelected: false,
    };
  }
  if (configuredOrganizationId && memberships.includes(configuredOrganizationId)) {
    return { organizationId: configuredOrganizationId, autoSelected: false };
  }
  return { organizationId: memberships[0], autoSelected: true };
}
