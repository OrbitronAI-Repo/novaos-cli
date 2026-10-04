/**
 * novaos-cli — MCP Server Log Streaming (Loki-backed)
 *
 * Fetches Loki-backed execution logs for a deployed MCP tool server from mcp-ops.
 * Supports --follow for SSE streaming, --since for historical range,
 * and --run-id to filter to a specific execution run.
 *
 * `mcpPodLogs` (mcp-pod-logs.ts) reads container stdout/stderr via K8s pod logs.
 */

import { randomUUID } from "node:crypto";

import {
  LogEntrySchema,
  LogsResponseSchema,
  type LogEntry,
} from "@novaos-cli/shared/contracts";

import { getAccessToken, getIdToken } from "./auth.js";
import { USER_AGENT, REQUEST_TIMEOUT_MS } from "./constants.js";
import { extractErrorDetail, withRequestId, type GalaxyHttpClient } from "./http-client.js";

export interface McpLogsOptions {
  follow?: boolean;
  since?: string;
  limit?: number;
  runId?: string;
  json?: boolean;
}

const LEVEL_COLORS: Record<string, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const SSE_STREAM_TIMEOUT_MS = REQUEST_TIMEOUT_MS * 10;
const SSE_MAX_RECONNECT_ATTEMPTS = 5;
const SSE_RECONNECT_BASE_DELAY_MS = 1_000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Extract the LogEntry[] from the mcp-ops Fastify envelope.
 * Handles: raw array, { logs }, { data: [...] }, { data: { logs } }.
 */
function extractLogs(body: unknown): { logs: LogEntry[]; total: number } {
  const candidate = unwrapCandidate(body);
  if (candidate === null) return { logs: [], total: 0 };
  const parsed = LogsResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `mcp-ops logs response failed contract validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

function unwrapCandidate(body: unknown): { logs: unknown[]; total: number } | null {
  if (Array.isArray(body)) return { logs: body, total: body.length };

  if (body !== null && typeof body === "object") {
    const obj = body as Record<string, unknown>;

    if ("data" in obj) {
      const inner = obj.data;
      if (Array.isArray(inner)) return { logs: inner, total: inner.length };
      if (inner !== null && typeof inner === "object") {
        const innerObj = inner as Record<string, unknown>;
        if (Array.isArray(innerObj.logs)) {
          return {
            logs: innerObj.logs,
            total: typeof innerObj.total === "number" ? innerObj.total : innerObj.logs.length,
          };
        }
      }
    }

    if (Array.isArray(obj.logs)) {
      return {
        logs: obj.logs,
        total: typeof obj.total === "number" ? obj.total : obj.logs.length,
      };
    }
  }

  return null;
}

function formatLogEntry(entry: LogEntry): string {
  const color = LEVEL_COLORS[entry.level] ?? "";
  const ts = entry.timestamp.replace("T", " ").replace("Z", "");
  const runTag = entry.run_id ? ` ${DIM}[run:${entry.run_id.slice(0, 8)}]${RESET}` : "";
  return `${DIM}${ts}${RESET} ${color}${entry.level.toUpperCase().padEnd(5)}${RESET} [${entry.source}]${runTag} ${entry.message}`;
}

/**
 * Fetch Loki-backed execution logs for an MCP tool server (by service UUID).
 */
export async function mcpLogs(
  client: GalaxyHttpClient,
  serverId: string,
  options: McpLogsOptions
): Promise<void> {
  const { follow = false, since = "1h", limit = 200, runId, json = false } = options;

  const params = new URLSearchParams({
    follow: String(follow),
    since,
    limit: String(limit),
  });
  if (runId) params.set("run_id", runId);

  const path = `/api/v1/mcp-ops/mcp-servers/${encodeURIComponent(serverId)}/logs?${params}`;

  if (follow) {
    await streamLogs(client, path, json);
  } else {
    const response = await client.request<Record<string, unknown>>(path);
    if (!response.ok) {
      const errorData = response.data as { error?: string; message?: string };
      throw new Error(
        withRequestId(
          extractErrorDetail(response.data) ||
            errorData.message ||
            `Failed to fetch MCP logs (HTTP ${response.status})`,
          response
        )
      );
    }
    const { logs } = extractLogs(response.data);
    if (json) {
      process.stdout.write(JSON.stringify(logs, null, 2) + "\n");
    } else if (logs.length === 0) {
      process.stdout.write("No logs found for the specified time range.\n");
    } else {
      for (const entry of logs) {
        process.stdout.write(formatLogEntry(entry) + "\n");
      }
      process.stdout.write(`\n${logs.length} log entries\n`);
      // mcp-ops always sets total = logs.length (it never reports the true match count beyond
      // the query's own limit), so total can never signal truncation. The returned count hitting
      // the requested limit exactly is the only truncation signal actually available here.
      if (logs.length >= limit) {
        process.stderr.write(
          `More entries may exist beyond this --limit of ${limit}. ` +
            `Re-run with a higher --limit or a narrower --since window to check.\n`
        );
      }
    }
  }
}

async function streamLogs(client: GalaxyHttpClient, path: string, json: boolean): Promise<void> {
  let attempt = 0;

  while (attempt <= SSE_MAX_RECONNECT_ATTEMPTS) {
    try {
      await streamOnce(client, path, json);
      return;
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;

      attempt++;
      if (attempt > SSE_MAX_RECONNECT_ATTEMPTS) {
        throw new Error(
          `Log stream disconnected after ${SSE_MAX_RECONNECT_ATTEMPTS} reconnect attempts: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
      const delay = Math.min(
        SSE_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5),
        SSE_RECONNECT_MAX_DELAY_MS
      );
      process.stdout.write(
        `${DIM}Stream disconnected, reconnecting (attempt ${attempt}/${SSE_MAX_RECONNECT_ATTEMPTS})...${RESET}\n`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function streamOnce(client: GalaxyHttpClient, path: string, json: boolean): Promise<void> {
  const token = await getAccessToken();
  const idToken = await getIdToken();

  const url = `${client.baseUrl}${path}`;
  const requestId = randomUUID();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-Request-ID": requestId,
    Accept: "text/event-stream",
  };
  if (idToken) headers["X-ID-Token"] = idToken;

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(SSE_STREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new NonRetryableError(
      `Failed to connect to MCP log stream (HTTP ${response.status}) (request ID: ${requestId})`
    );
  }

  if (!response.body) {
    throw new NonRetryableError("No response body for MCP log SSE stream");
  }

  process.stdout.write("Connected to MCP log stream. Press Ctrl+C to stop.\n\n");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith(":") || line.trim() === "") continue;
        if (line.startsWith("event:")) continue;

        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          try {
            const parsed = LogEntrySchema.safeParse(JSON.parse(payload));
            if (!parsed.success) {
              process.stdout.write(`${DIM}[malformed log entry skipped]${RESET} ${payload}\n`);
              continue;
            }
            const entry = parsed.data;
            if (json) {
              process.stdout.write(JSON.stringify(entry) + "\n");
            } else {
              process.stdout.write(formatLogEntry(entry) + "\n");
            }
          } catch {
            process.stdout.write(payload + "\n");
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
