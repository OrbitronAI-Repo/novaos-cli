/**
 * novaos-cli — Debug Commands
 *
 * Provides:
 *   novaos-cli debug trace   <run-id> [--json]
 *   novaos-cli debug watch   <run-id> [--json]
 *   novaos-cli debug compare <run-id-1> <run-id-2> [--json]
 *
 * Routes through the Marketplace BFF proxy (/api/gateway/) which
 * forwards to the Execution Gateway (/api/v1/).
 */

import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BFF_API_PREFIX = "/api/gateway";
const PLATFORM_NOT_AVAILABLE_MSG =
  "Agent Debugger platform is not yet available. This command will work once the Debug service is deployed.";

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

export interface DebugBreakpointOptions {
  runId: string;
  json?: boolean;
}

type DebugAction = "pause" | "resume" | "step" | "abort";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function isPlatformUnavailable(status: number): boolean {
  return status === 404 || status === 501;
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

export async function debugTrace(
  client: GalaxyHttpClient,
  opts: DebugTraceOptions
): Promise<EnrichedTrace | null> {
  const response = await client.request<EnrichedTrace>(
    `${BFF_API_PREFIX}/runs/${encodeURIComponent(opts.runId)}/trace`
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({ run_id: opts.runId, events: [], notice: PLATFORM_NOT_AVAILABLE_MSG });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return null;
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to fetch trace: HTTP ${response.status} \u2014 ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const trace = response.data;

  if (opts.json) {
    printJson(trace);
  } else {
    printEnrichedTrace(trace);
  }

  return trace;
}

const SSE_STREAM_TIMEOUT_MS = 600_000;

export async function debugWatch(client: GalaxyHttpClient, opts: DebugWatchOptions): Promise<void> {
  const streamPath = `${BFF_API_PREFIX}/runs/${encodeURIComponent(opts.runId)}/debug/stream`;

  const checkResponse = await client.request<unknown>(streamPath, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });

  if (isPlatformUnavailable(checkResponse.status)) {
    if (opts.json) {
      printJson({ run_id: opts.runId, streaming: false, notice: PLATFORM_NOT_AVAILABLE_MSG });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return;
  }

  const baseUrl = client.getBaseUrl();
  const authHeaders = await client.getAuthHeaders();

  if (!opts.json) {
    process.stdout.write(`Watching run ${opts.runId} for debug events...\n`);
    process.stdout.write("(Press Ctrl+C to stop)\n\n");
    process.stdout.write("TYPE".padEnd(18) + "TOOL/DETAIL".padEnd(24) + "TIME\n");
    process.stdout.write("-".repeat(HEADER_LINE_WIDTH) + "\n");
  }

  try {
    const response = await fetch(`${baseUrl}${streamPath}`, {
      headers: {
        ...authHeaders,
        Accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(SSE_STREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body — server did not return a stream");
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
): Promise<ComparisonResult | null> {
  const query = `?run_a=${encodeURIComponent(opts.runIdA)}&run_b=${encodeURIComponent(opts.runIdB)}`;
  const response = await client.request<ComparisonResult>(
    `${BFF_API_PREFIX}/debug/compare${query}`
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({
        run_a: opts.runIdA,
        run_b: opts.runIdB,
        diff: null,
        notice: PLATFORM_NOT_AVAILABLE_MSG,
      });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return null;
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to compare runs: HTTP ${response.status} \u2014 ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data;

  if (opts.json) {
    printJson(result);
  } else {
    printComparison(result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// debugBreakpoint — interactive breakpoint session
// ---------------------------------------------------------------------------

const DEBUG_ACTION_MAP: Record<string, DebugAction> = {
  p: "pause",
  r: "resume",
  s: "step",
  a: "abort",
};

export async function debugBreakpoint(
  client: GalaxyHttpClient,
  opts: DebugBreakpointOptions
): Promise<void> {
  const streamPath = `${BFF_API_PREFIX}/runs/${encodeURIComponent(opts.runId)}/debug/stream`;

  const baseUrl = client.getBaseUrl();
  const authHeaders = await client.getAuthHeaders();

  const sseResponse = await fetch(`${baseUrl}${streamPath}`, {
    headers: { ...authHeaders, Accept: "text/event-stream" },
    signal: AbortSignal.timeout(SSE_STREAM_TIMEOUT_MS),
  });

  if (!sseResponse.ok || !sseResponse.body) {
    if (isPlatformUnavailable(sseResponse.status)) {
      if (opts.json) {
        printJson({ run_id: opts.runId, streaming: false, notice: PLATFORM_NOT_AVAILABLE_MSG });
      } else {
        process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
      }
      return;
    }
    throw new Error(`Failed to connect: HTTP ${sseResponse.status}`);
  }

  if (!opts.json) {
    process.stdout.write(`Debug session for run ${opts.runId}\n`);
    process.stdout.write("Commands: [p]ause  [r]esume  [s]tep  [a]bort  [q]uit\n\n");
  }

  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  const readEvents = async (): Promise<void> => {
    while (!done) {
      const result = await reader.read();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
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
            done = true;
            return;
          }

          if (event.type === "debug.paused" && !opts.json) {
            const tool = String(event.payload?.pending_tool ?? "unknown");
            process.stdout.write(`\n>>> PAUSED before tool call: ${tool}\n`);
            process.stdout.write(
              "    [s]tep to execute, [r]esume to continue all, [a]bort to stop\n"
            );
          }

          if (opts.json) {
            printJson(event);
          } else {
            const color = EVENT_TYPE_COLORS[event.type] ?? "";
            const time = event.timestamp
              ? (new Date(event.timestamp).toISOString().split("T")[1]?.slice(0, 12) ?? "")
              : "";
            process.stdout.write(`${color}${event.type.padEnd(18)}${RESET}${time}\n`);
          }
        } catch {
          // skip unparseable SSE frames
        }
      }
    }
  };

  const eventPromise = readEvents().catch(() => {});

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on("data", async (key: Buffer) => {
      const char = key.toString();

      if (char === "q" || char === "\x03") {
        done = true;
        reader.cancel().catch(() => {});
        process.stdin.setRawMode(false);
        process.exit(0);
      }

      const action = DEBUG_ACTION_MAP[char];
      if (!action) return;

      try {
        const response = await client.request<{ breakpoint_state: string; action: string }>(
          `${BFF_API_PREFIX}/runs/${encodeURIComponent(opts.runId)}/debug/${action}`,
          { method: "POST", body: JSON.stringify({}) }
        );

        if (response.ok) {
          const state =
            (response.data as { breakpoint_state?: string }).breakpoint_state ?? "unknown";
          if (opts.json) {
            printJson({ action, breakpoint_state: state });
          } else {
            process.stdout.write(`\n  Action: ${action} \u2192 State: ${state}\n`);
          }

          if (action === "abort") {
            done = true;
            reader.cancel().catch(() => {});
            process.stdin.setRawMode(false);
            process.stdout.write("Session aborted.\n");
            process.exit(0);
          }
        } else {
          process.stderr.write(`\n  Failed: HTTP ${response.status}\n`);
        }
      } catch (err) {
        process.stderr.write(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });
  } else {
    if (!opts.json) {
      process.stdout.write("(Non-interactive mode \u2014 streaming events only)\n");
    }
  }

  await eventPromise;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}
