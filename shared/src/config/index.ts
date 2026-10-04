/**
 * Shared configuration constants
 */

// --- Timeouts ---
export const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
export const ACP_DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000; // 30 seconds
export const RATE_LIMIT_WINDOW_MS = 1_000; // 1 second
export const RATE_LIMIT_WINDOW_MINUTE_MS = 60_000; // 1 minute
export const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000; // 1 minute
export const PLUGIN_TIMEOUT_MS = 120_000; // 2 minutes
export const JWKS_CACHE_TTL_SECONDS = 3_600; // 1 hour
export const JWKS_CACHE_MAX_AGE_SECONDS = 300; // 5 minutes

// --- Size limits ---
export const DEFAULT_MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

// --- Rate and concurrency ---
export const DEFAULT_RATE_LIMIT_RPS = 10;
export const DEFAULT_CONCURRENCY_LIMIT = 5;

// --- Tenant LLM Gateway rate limits (platform defaults) ---
export const DEFAULT_TENANT_RPM = 60;
export const DEFAULT_TENANT_TPM = 100_000;
export const DEFAULT_TENANT_RPD = 10_000;
export const DEFAULT_TENANT_CONCURRENT = 10;
export const TENANT_RATE_LIMIT_CONFIG_CACHE_TTL_SECONDS = 60;

// --- Database query defaults ---
export const DEFAULT_QUERY_LIMIT = 100;
export const DEFAULT_THREAD_QUERY_LIMIT = 50;
export const DEFAULT_RUN_QUERY_LIMIT = 50;
export const DEFAULT_EVENT_QUERY_LIMIT = 1_000;

// --- Ports ---
export const DEFAULT_GATEWAY_PORT = 3_000;
export const DEFAULT_MCP_GATEWAY_PORT = 8_080;

// --- MCP Session ---
export const MCP_SESSION_TTL_MS = 5 * 60 * 1_000; // 5 minutes

// --- Enums (single source of truth) ---
/** All valid run statuses. Derive RunStatus type and Zod schemas from this. */
export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_USER",
  "WAITING_AUTH",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
] as const;
/** Convenience alias — narrowed to the RUN_STATUSES literal union. */
export type RunStatusValue = (typeof RUN_STATUSES)[number];
/**
 * Terminal run statuses — no further transitions allowed.
 *
 * `REJECTED` is terminal: the pod rejected the request outright, and
 * nothing resumes it. `WAITING_AUTH` is deliberately absent — it is an
 * interrupt, like `WAITING_USER`, not a terminal state.
 *
 * Typed as `ReadonlySet<RunStatusValue>` (not `ReadonlySet<string>`) so that
 * callers passing the values to a Prisma `RunWhereInput` (now typed as
 * `RunStatus`) keep the literal narrowing.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatusValue> = new Set<RunStatusValue>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
]);
export const AGENT_TYPES = ["ACP", "REST", "A2A"] as const;

/**
 * Agent catalog status values — use instead of bare string literals.
 *
 * - `draft`: auto-created by the installation service when an agent is
 *   discovered but has not yet been review-approved. Distinct from
 *   `published`. (Present in production data, so it is part of the
 *   canonical vocabulary.)
 * - `published`: review-approved and visible in the marketplace catalog.
 * - `deprecated`: soft-retired, excluded from default catalog queries.
 */
export const AGENT_CATALOG_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
  DEPRECATED: "deprecated",
} as const;

/** AgentRelease lifecycle status values. */
export const AGENT_RELEASE_STATUS = {
  ACTIVE: "ACTIVE",
  SUPERSEDED: "SUPERSEDED",
  ROLLED_BACK: "ROLLED_BACK",
  FAILED: "FAILED",
} as const;
export type AgentReleaseStatusValue =
  (typeof AGENT_RELEASE_STATUS)[keyof typeof AGENT_RELEASE_STATUS];

/** UserAgentInstance lifecycle status values. */
export const INSTANCE_STATUS = {
  INSTALLING: "INSTALLING",
  READY: "READY",
  ERROR: "ERROR",
} as const;

/**
 * Upgrade review status values for UserAgentInstance.review_status.
 * Only applies to SA-owned instances (FR-SA-14).
 * null/undefined = no pending review.
 */
export const INSTANCE_REVIEW_STATUS = {
  /** Review is in progress — instance runs are blocked until resolved. */
  PENDING_REVIEW: "pending_review",
} as const;
// Note: there are no terminal status values. Both approve and reject resolve the
// review by setting review_status back to null (no active review). The
// pending_release_id is also cleared, and reviewed_at / reviewed_by_user_id
// record the outcome for audit purposes.

/** Service registry status values. */
export const SERVICE_REGISTRY_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  DEPRECATED: "deprecated",
} as const;
export type ServiceRegistryStatusValue =
  (typeof SERVICE_REGISTRY_STATUS)[keyof typeof SERVICE_REGISTRY_STATUS];

/** Service registry health values (written by tool-health checker, read by tool queries). */
export const SERVICE_HEALTH = {
  UNKNOWN: "unknown",
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
} as const;
export type ServiceHealthValue = (typeof SERVICE_HEALTH)[keyof typeof SERVICE_HEALTH];

/** MCP server visibility (Service.visibility; McpServerVisibility enum in both schemas). */
export const MCP_SERVER_VISIBILITY = {
  PRIVATE: "private",
  SHARED: "shared",
  PUBLIC: "public",
} as const;
export type McpServerVisibilityValue =
  (typeof MCP_SERVER_VISIBILITY)[keyof typeof MCP_SERVER_VISIBILITY];

/**
 * Publishers whose MCP servers are first-party NovaOS: public, and subscribed for every
 * org by the entitlements backfill (scripts/backfill-mcp-server-entitlements.ts).
 */
export const FIRST_PARTY_PUBLISHERS: readonly string[] = ["novaos"];

export function isFirstPartyPublisher(publisher: string | null | undefined): boolean {
  return !!publisher && FIRST_PARTY_PUBLISHERS.includes(publisher);
}

/** McpToolVersion lifecycle status (control-plane Prisma; aligns with tool-review-fsm). */
export const MCP_TOOL_VERSION_STATUS = {
  PENDING_REVIEW: "pending_review",
  SCANNING: "scanning",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DEPRECATED: "deprecated",
} as const;

/** Thread lifecycle status values. */
export const THREAD_STATUS = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
} as const;

/** Publisher profile verification status values. */
export const PUBLISHER_STATUS = {
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  SUSPENDED: "SUSPENDED",
} as const;
export type PublisherStatusValue = (typeof PUBLISHER_STATUS)[keyof typeof PUBLISHER_STATUS];

/**
 * Publisher trust level values — admin-managed reputation flag.
 * Canonical casing is UPPERCASE to match the Prisma schema default
 * ("STANDARD") and existing column values; consumers (Zod, UI, policy
 * evaluator) MUST derive from this constant rather than redeclaring it.
 *
 * @see PublisherProfile.trust_level in packages/shared/prisma/schema.prisma
 */
export const PUBLISHER_TRUST_LEVEL = {
  STANDARD: "STANDARD",
  TRUSTED: "TRUSTED",
  BLOCKED: "BLOCKED",
} as const;
/** Tuple form of PUBLISHER_TRUST_LEVEL for use with z.enum(...). */
export const PUBLISHER_TRUST_LEVELS = [
  PUBLISHER_TRUST_LEVEL.STANDARD,
  PUBLISHER_TRUST_LEVEL.TRUSTED,
  PUBLISHER_TRUST_LEVEL.BLOCKED,
] as const;
export type PublisherTrustLevel = (typeof PUBLISHER_TRUST_LEVELS)[number];

/** Marketplace review lifecycle status values (align with review FSM / Prisma). */
export const REVIEW_STATUS = {
  PENDING_SCAN: "PENDING_SCAN",
  SCANNING: "SCANNING",
  PENDING_REVIEW: "PENDING_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  ACTIVE: "ACTIVE",
  ROLLED_BACK: "ROLLED_BACK",
} as const;

/**
 * Run lifecycle status values.
 *
 * `WAITING_AUTH` is the interrupt counterpart of `WAITING_USER`: an
 * A2A `TASK_STATE_AUTH_REQUIRED` pause — a connector OAuth prompt or a
 * write-confirmation gate; the pod's explicit `SkillResult.status` is
 * authoritative for both shapes. `REJECTED` is the
 * terminal counterpart of `FAILED` for an A2A `TASK_STATE_REJECTED` response —
 * a request the pod refused to route at all, as opposed to one that ran and
 * failed.
 */
export const RUN_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  WAITING_USER: "WAITING_USER",
  WAITING_AUTH: "WAITING_AUTH",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
} as const;

/** ShadowDeployment lifecycle status values. */
export const SHADOW_DEPLOYMENT_STATUS = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  ROLLED_BACK: "ROLLED_BACK",
} as const;
export type ShadowDeploymentStatusValue =
  (typeof SHADOW_DEPLOYMENT_STATUS)[keyof typeof SHADOW_DEPLOYMENT_STATUS];

/** ShadowExecution verdict values. */
export const SHADOW_VERDICT = {
  PENDING: "PENDING",
  PROMOTE: "PROMOTE",
  HOLD: "HOLD",
  REJECT: "REJECT",
} as const;
export type ShadowVerdictValue = (typeof SHADOW_VERDICT)[keyof typeof SHADOW_VERDICT];

/** HeartbeatConfig status values. */
export const HEARTBEAT_CONFIG_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
  DISABLED: "disabled",
} as const;
export type HeartbeatConfigStatusValue =
  (typeof HEARTBEAT_CONFIG_STATUS)[keyof typeof HEARTBEAT_CONFIG_STATUS];

/** HeartbeatSchedule status values. */
export const HEARTBEAT_SCHEDULE_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
} as const;
export type HeartbeatScheduleStatusValue =
  (typeof HEARTBEAT_SCHEDULE_STATUS)[keyof typeof HEARTBEAT_SCHEDULE_STATUS];

/** HeartbeatExecution status values. */
export const HEARTBEAT_EXECUTION_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  BUDGET_EXCEEDED: "budget_exceeded",
} as const;
export type HeartbeatExecutionStatusValue =
  (typeof HEARTBEAT_EXECUTION_STATUS)[keyof typeof HEARTBEAT_EXECUTION_STATUS];

/** ServiceRegistrySyncOutbox status values. */
export const SERVICE_REGISTRY_OUTBOX_STATUS = {
  PENDING: "PENDING",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;

/**
 * BudgetConfig lifecycle status. Single value today; future states
 * (`paused`, `exhausted`) require an additive Prisma migration with
 * `ALTER TYPE ... ADD VALUE`. Mirrors the `BudgetConfigStatus` Prisma
 * enum; M1c Tier-3.
 */
export const BUDGET_CONFIG_STATUS = {
  ACTIVE: "active",
} as const;
export type BudgetConfigStatusValue =
  (typeof BUDGET_CONFIG_STATUS)[keyof typeof BUDGET_CONFIG_STATUS];

/**
 * BudgetAlert delivery lifecycle status.
 * Mirrors the `BudgetAlertDeliveryStatus` Prisma enum; M1c Tier-3.
 */
export const BUDGET_ALERT_DELIVERY_STATUS = {
  PENDING: "pending",
  DELIVERED: "delivered",
  FAILED: "failed",
} as const;
export type BudgetAlertDeliveryStatusValue =
  (typeof BUDGET_ALERT_DELIVERY_STATUS)[keyof typeof BUDGET_ALERT_DELIVERY_STATUS];
