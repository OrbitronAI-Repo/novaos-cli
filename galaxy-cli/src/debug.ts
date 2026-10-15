/**
 * novaos-cli — Debug Commands
 *
 * Provides:
 *   novaos-cli debug trace   <run-id> [--json]
 *   novaos-cli debug watch   <run-id> [--json]
 *   novaos-cli debug compare <run-id-1> <run-id-2> [--json]
 *
 * Calls the Execution Gateway's /api/v1 routes directly with the CLI's bearer
 * token. (The Marketplace BFF's /api/gateway routes authenticate with a browser
 * session cookie, so the CLI cannot use them.) `watch` and `compare` are only
 * served when the gateway runs with DEBUGGER_ENABLED; `trace` is always served.
 */

import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATEWAY_API_PREFIX = "/api/v1";

// ---------------------------------------------------------------------------
// Types — Enriched Trace (matches gateway response)
// ---------------------------------------------------------------------------

export interface EnrichedRunEvent {
  event_id: string;
  run_id: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
  trace_id?: string;
  span_id?: string;
  duration_ms: number | null;
  paired_event_id: string | null;
}

export interface RunTraceSummary {
  total_events: number;
  tool_calls: number;
  errors: number;
  total_duration_ms: number;
  total_llm_cost_usd: number | null;
}

export interface RunInfo {
  run_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  instance_id: string;
  /** Failure reason from the run record; only set for a failed or rejected run. */
  error?: string;
}

export interface EnrichedTrace {
  run: RunInfo;
  events: EnrichedRunEvent[];
  summary: RunTraceSummary;
  langfuse?: {
    available: boolean;
    trace_id: string | null;
    observations: unknown[];
  };
}

// ---------------------------------------------------------------------------
// Types — Compare
// ---------------------------------------------------------------------------

export interface DivergencePoint {
  left_sequence: number | null;
  right_sequence: number | null;
  type: string;
  description: string;
}

export interface ComparisonDiff {
  duration_delta_ms: number;
  tool_calls_delta: number;
  error_count_delta: number;
  divergence_points: DivergencePoint[];
}

export interface ComparisonResult {
  left: EnrichedTrace;
  right: EnrichedTrace;
  diff: ComparisonDiff;
}

// ---------------------------------------------------------------------------
// Types — Command Options
// ---------------------------------------------------------------------------

export interface DebugTraceOptions {
  runId: string;
  json?: boolean;
}

export interface DebugWatchOptions {
  runId: string;
  json?: boolean;
}

export interface DebugCompareOptions {
  runIdA: string;
  runIdB: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/**
 * True when the gateway has no handler for the route (HTTP 501, or a 404 whose
 * body is not a handler-produced error). A handler's own 404 — for example an
 * unknown run, `DEBUG_RUN_NOT_FOUND` — is a real error, not "unavailable".
 */
export function isRouteUnavailable(status: number, data: unknown): boolean {
  if (status === 501) return true;
  if (status !== 404) return false;
  if (!data || typeof data !== "object") return true;
  const body = data as Record<string, unknown>;
  if (Array.isArray(body.errors)) return false;
  if (typeof body.error === "string" && body.error !== "Not Found") return false;
  return true;
}

/**
 * `/runs/compare` is only registered when the debugger is enabled. Without it,
 * the gateway's generic `/runs/:runId` route catches the request, reads
 * "compare" as a run ID, and answers 400 with a `runId` validation error.
 */
function isCompareShadowedByRunRoute(status: number, data: unknown): boolean {
  if (status !== 400 || !data || typeof data !== "object") return false;
  const body = data as { error?: unknown; details?: { fieldErrors?: Record<string, unknown> } };
  return body.error === "VALIDATION_ERROR" && body.details?.fieldErrors?.runId !== undefined;
}

export class DebugUnavailableError extends Error {
  constructor(url: string, status: number) {
    super(
      `The debug endpoint is not available at ${url} (HTTP ${status}). ` +
        "The gateway does not serve this route: the debugger may be disabled " +
        "(DEBUGGER_ENABLED) or the gateway build predates it."
    );
    this.name = "DebugUnavailableError";
  }
}

function unavailable(client: GalaxyHttpClient, path: string, status: number): never {
  throw new DebugUnavailableError(`${client.getBaseUrl()}${path}`, status);
}

/** The gateway wraps successful bodies as `{ data: ... }`. */
function unwrapData<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  "tool.call": "\x1b[34m",
  "tool.result": "\x1b[32m",
  "message.delta": "\x1b[90m",
  "message.final": "\x1b[35m",
  status: "\x1b[33m",
  error: "\x1b[31m",
  "hitl.request": "\x1b[33m",
};
const RESET = "\x1b[0m";
const HEADER_LINE_WIDTH = 72;

function printEnrichedTrace(trace: EnrichedTrace): void {
  const { run, events, summary } = trace;

  process.stdout.write(`\nRun ${run.run_id}\n`);
  process.stdout.write(`Status: ${run.status}  Duration: ${run.duration_ms ?? "\u2014"}ms\n`);
  if (run.error) {
    process.stdout.write(`Error: ${run.error}\n`);
  }
  process.stdout.write(
    `Started: ${run.started_at}  Finished: ${run.finished_at ?? "in progress"}\n`
  );
  process.stdout.write("\u2500".repeat(HEADER_LINE_WIDTH) + "\n");

  process.stdout.write(
    `Events: ${summary.total_events}  Tool Calls: ${summary.tool_calls}  ` +
      `Errors: ${summary.errors}  Duration: ${summary.total_duration_ms}ms\n`
  );
  if (summary.total_llm_cost_usd != null) {
    process.stdout.write(`LLM Cost: $${summary.total_llm_cost_usd.toFixed(4)}\n`);
  }
  process.stdout.write("\u2500".repeat(HEADER_LINE_WIDTH) + "\n\n");

  process.stdout.write(
    "SEQ".padEnd(6) +
      "TYPE".padEnd(18) +
      "TOOL/DETAIL".padEnd(28) +
      "DURATION".padEnd(12) +
      "TIME\n"
  );
  process.stdout.write("-".repeat(HEADER_LINE_WIDTH) + "\n");

  for (const event of events) {
    const color = EVENT_TYPE_COLORS[event.type] ?? "";
    const toolName =
      event.type === "tool.call" || event.type === "tool.result"
        ? String(event.payload?.tool_name ?? "")
        : "";
    const duration = event.duration_ms != null ? `${event.duration_ms}ms` : "";
    const time = new Date(event.timestamp).toISOString().split("T")[1]?.slice(0, 12) ?? "";

    process.stdout.write(
      `${String(event.sequence).padEnd(6)}` +
        `${color}${event.type.padEnd(18)}${RESET}` +
        `${toolName.padEnd(28)}` +
        `${duration.padEnd(12)}` +
        `${time}\n`
    );
  }
}

function printComparison(result: ComparisonResult): void {
  const { left, right, diff } = result;

  process.stdout.write(`\nComparing ${left.run.run_id} vs ${right.run.run_id}\n`);
  process.stdout.write("\u2500".repeat(HEADER_LINE_WIDTH) + "\n");

  process.stdout.write(
    `Duration delta:    ${diff.duration_delta_ms > 0 ? "+" : ""}${diff.duration_delta_ms}ms\n`
  );
  process.stdout.write(
    `Tool calls delta:  ${diff.tool_calls_delta > 0 ? "+" : ""}${diff.tool_calls_delta}\n`
  );
  process.stdout.write(
    `Error count delta: ${diff.error_count_delta > 0 ? "+" : ""}${diff.error_count_delta}\n`
  );

  if (diff.divergence_points.length === 0) {
    process.stdout.write("\nNo divergence points found.\n");
  } else {
    process.stdout.write(`\nDivergence points (${diff.divergence_points.length}):\n`);
    for (const dp of diff.divergence_points) {
      const leftSeq = dp.left_sequence != null ? `L:${dp.left_sequence}` : "L:\u2014";
      const rightSeq = dp.right_sequence != null ? `R:${dp.right_sequence}` : "R:\u2014";
      process.stdout.write(`  [${leftSeq} ${rightSeq}] ${dp.type}: ${dp.description}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const FAILED_RUN_STATUSES = new Set(["failed", "rejected"]);

/**
 * The reason a run failed lives on the run record, not in the trace: a run that
 * failed before failure events were persisted has an empty timeline, so this is
 * its only record. Best-effort, since the trace itself is already in hand.
 */
async function fetchRunError(client: GalaxyHttpClient, runId: string): Promise<string | undefined> {
  try {
    const response = await client.request<unknown>(
      `${GATEWAY_API_PREFIX}/runs/${encodeURIComponent(runId)}`
    );
    if (!response.ok) return undefined;
    const error = (response.data as { error?: unknown } | null)?.error;
    return typeof error === "string" && error.length > 0 ? error : undefined;
  } catch {
    return undefined;
  }
}

export async function debugTrace(
  client: GalaxyHttpClient,
  opts: DebugTraceOptions
): Promise<EnrichedTrace> {
  const path = `${GATEWAY_API_PREFIX}/runs/${encodeURIComponent(opts.runId)}/trace`;
  const response = await client.request<unknown>(path);

  if (isRouteUnavailable(response.status, response.data)) {
    unavailable(client, path, response.status);
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to fetch trace: HTTP ${response.status} \u2014 ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const trace = unwrapData<EnrichedTrace>(response.data);

  if (FAILED_RUN_STATUSES.has(String(trace.run.status).toLowerCase())) {
    const error = await fetchRunError(client, opts.runId);
    if (error) trace.run.error = error;
  }

  if (opts.json) {
    printJson(trace);
  } else {
    printEnrichedTrace(trace);
  }

  return trace;
}

const SSE_STREAM_TIMEOUT_MS = 600_000;

export async function debugWatch(client: GalaxyHttpClient, opts: DebugWatchOptions): Promise<void> {
  const streamPath = `${GATEWAY_API_PREFIX}/runs/${encodeURIComponent(opts.runId)}/debug/stream`;
  const baseUrl = client.getBaseUrl();
  const authHeaders = await client.getAuthHeaders();

  try {
    const response = await fetch(`${baseUrl}${streamPath}`, {
      headers: {
        ...authHeaders,
        Accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(SSE_STREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody: unknown = await response.json().catch(() => ({}));
      if (isRouteUnavailable(response.status, errorBody)) {
        unavailable(client, streamPath, response.status);
      }
      throw new Error(`HTTP ${response.status} \u2014 ${JSON.stringify(errorBody)}`);
    }

    if (!response.body) {
      throw new Error("No response body — server did not return a stream");
    }

    if (!opts.json) {
      process.stdout.write(`Watching run ${opts.runId} for debug events...\n`);
      process.stdout.write("(Press Ctrl+C to stop)\n\n");
      process.stdout.write("TYPE".padEnd(18) + "TOOL/DETAIL".padEnd(24) + "TIME\n");
      process.stdout.write("-".repeat(HEADER_LINE_WIDTH) + "\n");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const event = JSON.parse(line.slice(6)) as {
            type: string;
            sequence?: number;
            timestamp?: string;
            payload?: Record<string, unknown>;
          };

          if (event.type === "done") {
            if (opts.json) {
              printJson({ type: "done", run_id: opts.runId });
            } else {
              process.stdout.write("\nRun completed.\n");
            }
            return;
          }

          if (opts.json) {
            printJson(event);
          } else {
            const color = EVENT_TYPE_COLORS[event.type] ?? "";
            const time = event.timestamp
              ? (new Date(event.timestamp).toISOString().split("T")[1]?.slice(0, 12) ?? "")
              : "";
            const toolName = event.payload?.tool_name
              ? ` [${String(event.payload.tool_name)}]`
              : "";
            process.stdout.write(
              `${color}${event.type.padEnd(18)}${RESET}${toolName.padEnd(24)}${time}\n`
            );
          }
        } catch {
          // skip unparseable SSE frames
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      process.stdout.write("\nStream timed out.\n");
    } else {
      throw err;
    }
  }
}

export async function debugCompare(
  client: GalaxyHttpClient,
  opts: DebugCompareOptions
): Promise<ComparisonResult> {
  const path =
    `${GATEWAY_API_PREFIX}/runs/compare` +
    `?left=${encodeURIComponent(opts.runIdA)}&right=${encodeURIComponent(opts.runIdB)}`;
  const response = await client.request<unknown>(path);

  if (
    isRouteUnavailable(response.status, response.data) ||
    isCompareShadowedByRunRoute(response.status, response.data)
  ) {
    unavailable(client, path, response.status);
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to compare runs: HTTP ${response.status} \u2014 ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = unwrapData<ComparisonResult>(response.data);

  if (opts.json) {
    printJson(result);
  } else {
    printComparison(result);
  }

  return result;
}
