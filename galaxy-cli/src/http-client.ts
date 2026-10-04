/**
 * Authenticated HTTP Client for novaos-cli
 *
 * Wraps fetch with automatic Bearer token injection, request tracing,
 * transparent 401 retry with token refresh, and configurable retry/backoff
 * on transient failures (see RetryConfig).
 *
 * fetch, the token functions, retry config, and the retry delay itself are
 * all injectable (see GalaxyHttpClientDeps) so tests can construct a real
 * client against fakes — including running retry tests with zero real
 * delay — instead of monkeypatching globalThis.fetch or mock.module()-ing
 * ./auth.js. createGalaxyHttpClient is the single composition root — call
 * sites should use it rather than `new GalaxyHttpClient(...)` directly.
 */

import { randomUUID } from "node:crypto";

import { getErrorMessage, stripTrailingSlash } from "@novaos-cli/shared/utils";

import {
  getAccessToken as defaultGetAccessToken,
  getIdToken as defaultGetIdToken,
} from "./auth.js";
import {
  USER_AGENT,
  MAX_AUTH_RETRIES,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "./constants.js";
import { type RetryConfig, type RetryMode, resolveDefaultRetryConfig } from "./retry-config.js";

export type { RetryMode, RetryConfig } from "./retry-config.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  /** The X-Request-ID sent on this request — surface it in error messages so users can hand it to support. */
  requestId: string;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";
const REDACTED_HEADERS = new Set(["authorization", "x-id-token"]);

/** Redacts secret header values (bearer token, ID token) for --debug output. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return redacted;
}

/**
 * Thrown when the 401 refresh-and-retry itself fails — a permanent auth
 * failure, not a transient one. The retry loop in request() must not retry
 * this like a transient error: it would just repeat the stale-token request
 * and another failed refresh on every remaining attempt before finally
 * surfacing the same error to the user.
 */
class AuthSessionExpiredError extends Error {}

export interface GalaxyHttpClientDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: typeof defaultGetAccessToken;
  getIdToken?: typeof defaultGetIdToken;
  retry?: Partial<RetryConfig>;
  /** Retry backoff delay — injectable so retry tests run with zero real wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** When true, prints redacted request/response detail for every HTTP call to stderr. */
  debug?: boolean;
  /** Debug log sink — injectable so tests can assert on output without capturing real stderr. */
  debugLog?: (line: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff, capped, per attempt (1-indexed). */
function backoffDelayMs(attempt: number): number {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp);
}

export class GalaxyHttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: typeof defaultGetAccessToken;
  private readonly getIdToken: typeof defaultGetIdToken;
  private readonly retryMode: RetryMode;
  private readonly maxAttempts: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly debug: boolean;
  private readonly debugLog: (line: string) => void;
  /** adaptive mode only: throttles fresh calls after a streak of failures on this client. */
  private consecutiveFailures = 0;

  constructor(baseUrl: string, deps: GalaxyHttpClientDeps = {}) {
    if (!baseUrl) {
      throw new Error("Base URL is required for GalaxyHttpClient");
    }
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
    this.getIdToken = deps.getIdToken ?? defaultGetIdToken;
    const envDefault = resolveDefaultRetryConfig();
    this.retryMode = deps.retry?.mode ?? envDefault.mode;
    this.maxAttempts = deps.retry?.maxAttempts ?? envDefault.maxAttempts;
    this.sleepImpl = deps.sleepImpl ?? defaultSleep;
    this.debug = deps.debug ?? false;
    this.debugLog = deps.debugLog ?? ((line) => process.stderr.write(`${line}\n`));
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    };
    const idToken = await this.getIdToken();
    if (idToken) {
      headers["X-ID-Token"] = idToken;
    }
    return headers;
  }

  /**
   * A retry is only safe for a GET, or a mutating call carrying an
   * idempotency key — retrying a mutating call with no such key risks a
   * duplicate side effect (e.g. a second /publish/auth would mint a second
   * registry token). Callers that need retry on a mutating endpoint must
   * supply one, as publish/finalize's X-Idempotency-Key does.
   */
  private isRetrySafe(method: string, headers: Record<string, string>): boolean {
    if (method === "GET") return true;
    return Object.keys(headers).some((key) => key.toLowerCase() === IDEMPOTENCY_KEY_HEADER);
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const { method = "GET", body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = options;

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (error) {
      throw new Error(
        `Authentication required. Run 'novaos-cli auth login' first.\n` +
          `Details: ${getErrorMessage(error)}`
      );
    }

    const idToken = await this.getIdToken();
    const allHeaders = { ...headers };
    if (idToken) {
      allHeaders["X-ID-Token"] = idToken;
    }

    const retrySafe = this.retryMode !== "none" && this.isRetrySafe(method, allHeaders);
    const maxAttempts = retrySafe ? this.maxAttempts : 1;

    if (retrySafe && this.retryMode === "adaptive" && this.consecutiveFailures > 0) {
      await this.sleepImpl(backoffDelayMs(this.consecutiveFailures));
    }

    let currentToken = token;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await this.sleepImpl(backoffDelayMs(attempt - 1));
      }

      try {
        let result = await this.executeRequest<T>(
          path,
          method,
          body,
          allHeaders,
          currentToken,
          timeoutMs
        );

        if (result.status === 401 && MAX_AUTH_RETRIES > 0) {
          currentToken = await this.retryWithRefresh();
          result = await this.executeRequest<T>(
            path,
            method,
            body,
            allHeaders,
            currentToken,
            timeoutMs
          );
        }

        if (attempt < maxAttempts && RETRYABLE_STATUS_CODES.has(result.status)) {
          continue;
        }

        this.recordOutcome(result.ok);
        return result;
      } catch (error) {
        if (error instanceof AuthSessionExpiredError) {
          this.recordOutcome(false);
          throw error;
        }
        lastError = error;
        if (attempt === maxAttempts) {
          this.recordOutcome(false);
          throw error;
        }
      }
    }

    // Unreachable: the loop above always returns or throws on its last iteration.
    throw lastError;
  }

  private recordOutcome(ok: boolean): void {
    this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1;
  }

  private async executeRequest<T>(
    path: string,
    method: string,
    body: unknown | undefined,
    extraHeaders: Record<string, string>,
    token: string,
    timeoutMs: number
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const requestId = randomUUID();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "X-Request-ID": requestId,
      "Content-Type": "application/json",
      ...extraHeaders,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    if (this.debug) {
      this.debugLog(
        `[debug] --> ${method} ${url} requestId=${requestId} headers=${JSON.stringify(redactHeaders(headers))}`
      );
    }
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (this.debug) {
        this.debugLog(
          `[debug] <-- ${response.status} ${method} ${url} requestId=${requestId} ${Date.now() - startedAt}ms`
        );
      }

      const data = (await response.json().catch(() => ({}))) as T;

      return {
        ok: response.ok,
        status: response.status,
        data,
        requestId,
      };
    } catch (error) {
      if (this.debug) {
        this.debugLog(
          `[debug] xx  ${method} ${url} requestId=${requestId} ${Date.now() - startedAt}ms error=${getErrorMessage(error)}`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async retryWithRefresh(): Promise<string> {
    try {
      return await this.getAccessToken({ forceRefresh: true });
    } catch {
      throw new AuthSessionExpiredError(
        "Session expired and refresh failed. Run 'novaos-cli auth login' to re-authenticate."
      );
    }
  }
}

/**
 * Create an authenticated HTTP client for a platform service — the single
 * composition root for GalaxyHttpClient; call sites should use this instead
 * of `new GalaxyHttpClient(...)` directly.
 */
export function createGalaxyHttpClient(
  baseUrl: string,
  deps?: GalaxyHttpClientDeps
): GalaxyHttpClient {
  return new GalaxyHttpClient(baseUrl, deps);
}

/**
 * Extracts a human-readable error message from the API error envelope.
 * Handles both ProblemDetail format ({ errors: [{ detail, code }] })
 * and legacy flat format ({ message, error }).
 */
export function extractErrorDetail(data: unknown): string {
  if (typeof data !== "object" || data === null) return "Unknown error";
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0] as Record<string, unknown>;
    const detail = first.detail ?? first.message;
    const code = first.code;
    if (typeof detail === "string") {
      return withErrorHint(code ? `[${code}] ${detail}` : detail, code);
    }
  }

  if (typeof obj.message === "string") return withErrorHint(obj.message, obj.error);
  if (typeof obj.error === "string") return withErrorHint(obj.error, obj.error);

  return JSON.stringify(data);
}

/** Error codes whose fix is a CLI command the user can run. */
export const ORG_CONTEXT_REQUIRED_HINT =
  "This command must run in an organization. Run 'novaos-cli auth org list' and " +
  "'novaos-cli auth org use <organization-id>', or 'novaos-cli auth login' again if you " +
  "joined an organization after signing in.";

function withErrorHint(message: string, code: unknown): string {
  // The gateway rejects execution with a token that has no organization.
  if (code === "ORG_CONTEXT_REQUIRED") return `${message}\n  ${ORG_CONTEXT_REQUIRED_HINT}`;
  return message;
}

/** Appends the request id to an HTTP failure message, so callers who throw on a non-ok response surface it. */
export function withRequestId(message: string, response: Pick<ApiResponse, "requestId">): string {
  return `${message} (request ID: ${response.requestId})`;
}
