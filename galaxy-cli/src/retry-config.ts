/**
 * GalaxyHttpClient retry mode/max-attempts types and env-var-level defaults.
 *
 * Kept separate from http-client.ts (which depends on auth.ts) so that
 * config.ts — which auth.ts itself depends on — can resolve retry config
 * without creating a config.ts -> http-client.ts -> auth.ts -> config.ts cycle.
 */

import { RETRY_MODES, DEFAULT_RETRY_MODE, DEFAULT_MAX_ATTEMPTS } from "./constants.js";

/** "none" retries nothing; "standard" and "adaptive" retry idempotent transient failures. */
export type RetryMode = (typeof RETRY_MODES)[number];

export interface RetryConfig {
  mode: RetryMode;
  maxAttempts: number;
}

export function isValidRetryMode(value: string): value is RetryMode {
  return (RETRY_MODES as readonly string[]).includes(value);
}

/**
 * The default retry config, honoring NOVAOS_RETRY_MODE/NOVAOS_MAX_ATTEMPTS
 * env vars — so every GalaxyHttpClient respects them even when a caller
 * doesn't explicitly resolve retry config. config.ts's resolveRetryConfig
 * layers CLI --flag and config-file precedence on top of this.
 */
export function resolveDefaultRetryConfig(): RetryConfig {
  let mode: RetryMode = DEFAULT_RETRY_MODE;
  const envMode = process.env.NOVAOS_RETRY_MODE;
  if (envMode && isValidRetryMode(envMode)) {
    mode = envMode;
  }

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  const envMaxAttempts = process.env.NOVAOS_MAX_ATTEMPTS;
  if (envMaxAttempts) {
    const parsed = Number.parseInt(envMaxAttempts, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxAttempts = parsed;
    }
  }

  return { mode, maxAttempts };
}
