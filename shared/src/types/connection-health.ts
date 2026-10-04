/**
 * Closed-set health status and poller constants for org ConnectorInstance rows.
 * Prisma stores healthStatus as String; this module is the domain union.
 */

export const CONNECTION_HEALTH_STATUS = ["healthy", "degraded", "unreachable", "unknown"] as const;

export type ConnectionHealthStatus = (typeof CONNECTION_HEALTH_STATUS)[number];

export const HEALTH_FAILURE_NOTIFICATION_THRESHOLD = 5;
export const HEALTH_NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const HEALTH_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const HEALTH_CHECK_CONCURRENCY = 5;
export const HEALTH_POLL_PAGE_SIZE = 100;
