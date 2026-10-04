/**
 * Shared TypeScript types
 */

import { RUN_STATUSES } from "../config/index.js";

// Execution types — derived from the single source of truth in config
export type RunStatus = (typeof RUN_STATUSES)[number];

// Adapter selector, not a wire protocol — "A2A" is canonical; "ACP" is a
// deprecated legacy alias for the adapter that speaks A2A. Use
// isSdkAdapter() / isRestAdapter() from the shared utils module for
// comparisons.
export type AgentType = "ACP" | "REST" | "A2A";

// Auth types
export interface AuthContext {
  subjectId: string;
  tenantId: string;
  orgId?: string;
  scopes: string[];
  roles?: string[];
  /** Tenant monthly cost budget in USD.
   *  Populated from Logto organization customData.cost_budget_usd.
   *  Used by LLM Gateway for per-tenant budget enforcement (ADR 0006). */
  costBudgetUsd?: number;
  /**
   * Positive-assertion actor type.
   * "service_account" — Logto M2M client_credentials token whose client_id is in sa:registered.
   * "user" — standard auth-code/PKCE user token (client_id ≠ subjectId).
   */
  actorType: "user" | "service_account";
  /**
   * For service_account tokens: the Logto M2M app client_id.
   * Null for all user flows.
   */
  principalId: string | null;
  /**
   * Verified OAuth `client_id` from the access token (Logto JWT / introspection).
   * For M2M: equals subjectId. For human user tokens: the OAuth app ID (e.g. Studio).
   * Absent when the claim is missing after validation.
   */
  clientId?: string;
}

/**
 * SA tokens carry principalId (internal SA UUID from `sa:principal_by_client` Redis hash).
 * Marketplace API stores instances/threads/etc. with this UUID as user_id, not the Logto
 * client_id. For regular users, principalId is null so we fall back to subjectId (JWT sub).
 *
 * Every route that filters marketplace-owned rows by user_id must use this instead of
 * `auth.subjectId` directly, or a service-account caller silently sees an empty result set.
 */
export function effectiveUserId(auth: Pick<AuthContext, "principalId" | "subjectId">): string {
  return auth.principalId ?? auth.subjectId;
}

// Error types — all support ES2022 `cause` chaining for preserving original stack traces.
export class MarketplaceError extends Error {
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    options?: { cause?: unknown; retryable?: boolean }
  ) {
    super(message, options);
    this.name = this.constructor.name;
    this.retryable = options?.retryable ?? false;
  }

  /** Alias for statusCode — ensures duck-typing compatibility with isDomainError checks. */
  get status(): number {
    return this.statusCode;
  }
}

/** 404 — resource not found */
export class NotFoundError extends MarketplaceError {
  constructor(resource: string, identifier: string, code?: string, options?: { cause?: unknown }) {
    super(
      `${resource} not found: ${identifier}`,
      code ?? `${resource.toUpperCase()}_NOT_FOUND`,
      404,
      options
    );
  }
}

/** 409 — conflict (e.g. duplicate key, sequence conflict) */
export class ConflictError extends MarketplaceError {
  constructor(message: string, code?: string, options?: { cause?: unknown }) {
    super(message, code ?? "CONFLICT", 409, options);
  }
}

/** 401 — authentication failed */
export class AuthenticationError extends MarketplaceError {
  constructor(
    message: string = "Authentication failed",
    code?: string,
    options?: { cause?: unknown }
  ) {
    super(message, code ?? "AUTHENTICATION_ERROR", 401, options);
  }
}

/** 403 — authorization / access denied */
export class AuthorizationError extends MarketplaceError {
  constructor(message: string = "Access denied", code?: string, options?: { cause?: unknown }) {
    super(message, code ?? "AUTHORIZATION_ERROR", 403, options);
  }
}

/** 400 — invalid input / validation failure */
export class ValidationError extends MarketplaceError {
  constructor(message: string, code?: string, options?: { cause?: unknown }) {
    super(message, code ?? "VALIDATION_ERROR", 400, options);
  }
}

/** 503 — required dependency unavailable (e.g. Redis-backed limits when fail-closed) */
export class ServiceUnavailableError extends MarketplaceError {
  constructor(message: string, code?: string, options?: { cause?: unknown }) {
    super(message, code ?? "SERVICE_UNAVAILABLE", 503, { ...options, retryable: true });
  }
}

/** 429 — rate or concurrency limit exceeded */
export class RateLimitError extends MarketplaceError {
  public readonly retryAfterSeconds: number;

  constructor(
    message: string,
    code?: string,
    options?: { cause?: unknown; retryAfterSeconds?: number }
  ) {
    super(message, code ?? "RATE_LIMIT_EXCEEDED", 429, { ...options, retryable: true });
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 1;
  }
}

/** 500 — misconfiguration */
export class ConfigurationError extends MarketplaceError {
  constructor(message: string, code?: string, options?: { cause?: unknown }) {
    super(message, code ?? "CONFIGURATION_ERROR", 500, options);
  }
}

// ---------------------------------------------------------------------------
// HTTP Constants
// ---------------------------------------------------------------------------

/** Length of the "Bearer " prefix in Authorization headers. */
export const BEARER_PREFIX_LENGTH = 7;

// Temporal workflow input types (canonical definitions)
export type { ResolvedAgent, AgentResourceOverrides } from "./temporal-types.js";
export { catalogVersionForInstallPin } from "./catalog-version.js";

export * from "./external-mcp.js";
export * from "./connector-error-category.js";
export * from "./connection-health.js";
