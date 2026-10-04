/**
 * novaos-cli — Agent Log Streaming
 *
 * Fetches Loki-backed execution logs from the AgentOps service.
 * Supports --follow for SSE streaming, --since for historical range,
 * and --run-id to filter to a specific execution run.
 *
 * `agentPodLogs` reads container stdout/stderr via GET .../pod-logs (K8s pod logs).
 */

import { randomUUID } from "node:crypto";

import {
  LogEntrySchema,
  LogsResponseSchema,
  type LogEntry,
} from "@novaos-cli/shared/contracts";
import { z } from "zod";

import { getAccessToken, getIdToken } from "./auth.js";
import { USER_AGENT, REQUEST_TIMEOUT_MS } from "./constants.js";
import { extractErrorDetail, withRequestId, type GalaxyHttpClient } from "./http-client.js";

interface AgentLogsOptions {
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

/**
 * Extract the LogEntry[] from any upstream response shape.
 * Agent OPS wraps in Fastify envelope: { data: { logs, total }, meta, errors }
 * Handles: raw array, { logs }, { data: [...] }, { data: { logs } }.
 *
 * Strategy: reduce the body to the canonical `{ logs, total }` shape. If no
 * logs-bearing shape is present, fall back to an empty response (matches the
 * historical "No logs found" UX). If a logs-bearing shape IS present but
 * fails `LogsResponseSchema`, throw so contract drift is loud and actionable
 * instead of silently rendering bad output.
 */
function extractLogs(body: unknown): { logs: LogEntry[]; total: number } {
  const candidate = unwrapCandidate(body);
  if (candidate === null) return { logs: [], total: 0 };
  const parsed = LogsResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `agent-ops logs response failed contract validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

/**
 * Reduce any of the historical upstream shapes to the canonical
 * `{ logs, total }` contract before Zod validation. Returns `null` when the
 * body has no discoverable logs-bearing shape (e.g. `{}`, `{ data: null }`),
 * signalling that the caller should treat it as an empty result rather than
 * a contract violation.
 */
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

export async function agentLogs(
  client: GalaxyHttpClient,
  agentId: string,
  options: AgentLogsOptions
): Promise<void> {
  const { follow = false, since = "1h", limit = 200, runId, json = false } = options;

  const params = new URLSearchParams({
    follow: String(follow),
    since,
    limit: String(limit),
  });
  if (runId) params.set("run_id", runId);

  const path = `/api/v1/agent-ops/agents/${agentId}/logs?${params}`;

  if (follow) {
    await streamLogs(client, path, json);
  } else {
    const response = await client.request<Record<string, unknown>>(path);
    if (!response.ok) {
      const errorData = response.data as { error?: string; message?: string };
      throw new Error(
        withRequestId(
          errorData.message ?? `Failed to fetch logs (HTTP ${response.status})`,
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
      // agent-ops always sets total = logs.length (it never reports the true match count beyond
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

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
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

/**
 * Execute a single SSE connection. Returns when the stream ends normally.
 * Throws on network/timeout errors for the reconnect loop to handle.
 */
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
      `Failed to connect to log stream (HTTP ${response.status}) (request ID: ${requestId})`
    );
  }

  if (!response.body) {
    throw new NonRetryableError("No response body for SSE stream");
  }

  process.stdout.write("Connected to log stream. Press Ctrl+C to stop.\n\n");

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

// ---------------------------------------------------------------------------
// Pod logs (K8s container stdout/stderr)
// ---------------------------------------------------------------------------

const PodLogLineSchema = z.object({
  timestamp: z.string().nullable().optional(),
  line: z.string(),
});

const PodLogsPayloadSchema = z.object({
  logs: z.array(PodLogLineSchema),
  pod_name: z.string().optional(),
});

export type AgentPodLogLine = z.infer<typeof PodLogLineSchema>;

export interface AgentPodLogsOptions {
  follow?: boolean;
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  json?: boolean;
}

const DEFAULT_POD_CONTAINER = "agent";
const VALID_POD_CONTAINERS = new Set(["agent", "auth-proxy"]);
const DEFAULT_POD_TAIL_LINES = 200;
const MAX_POD_TAIL_LINES = 10_000;
const DEFAULT_POD_SINCE_SECONDS = 3600;
const MAX_POD_SINCE_SECONDS = 86_400;

function normalizeAgentPodLogsOptions(opts: AgentPodLogsOptions): {
  follow: boolean;
  json: boolean;
  container: string;
  tailLines: number;
  sinceSeconds: number;
} {
  const rawContainer = opts.container ?? DEFAULT_POD_CONTAINER;
  if (!VALID_POD_CONTAINERS.has(rawContainer)) {
    throw new Error(`container must be one of: ${[...VALID_POD_CONTAINERS].join(", ")}`);
  }
  const tailLines = Math.min(
    MAX_POD_TAIL_LINES,
    Math.max(1, opts.tailLines ?? DEFAULT_POD_TAIL_LINES)
  );
  const sinceSeconds = Math.min(
    MAX_POD_SINCE_SECONDS,
    Math.max(1, opts.sinceSeconds ?? DEFAULT_POD_SINCE_SECONDS)
  );
  return {
    follow: opts.follow ?? false,
    json: opts.json ?? false,
    container: rawContainer,
    tailLines,
    sinceSeconds,
  };
}

function unwrapPodLogsBody(body: unknown): { logs: unknown[]; pod_name?: string } | null {
  if (body === null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if ("data" in obj && obj.data !== null && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    if (Array.isArray(d.logs)) {
      return {
        logs: d.logs,
        pod_name: typeof d.pod_name === "string" ? d.pod_name : undefined,
      };
    }
  }
  if (Array.isArray(obj.logs)) {
    return {
      logs: obj.logs,
      pod_name: typeof obj.pod_name === "string" ? obj.pod_name : undefined,
    };
  }
  return null;
}

function extractPodLogs(body: unknown): z.infer<typeof PodLogsPayloadSchema> {
  const c = unwrapPodLogsBody(body);
  if (c === null) return { logs: [] };
  const parsed = PodLogsPayloadSchema.safeParse({ logs: c.logs, pod_name: c.pod_name });
  if (!parsed.success) {
    throw new Error(
      `agent-ops pod-logs response failed contract validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

function formatPodLogLine(entry: z.infer<typeof PodLogLineSchema>): string {
  if (entry.timestamp) {
    const ts = entry.timestamp.replace("T", " ").replace("Z", "");
    return `${DIM}${ts}${RESET} ${entry.line}`;
  }
  return entry.line;
}

export async function agentPodLogs(
  client: GalaxyHttpClient,
  agentId: string,
  options: AgentPodLogsOptions = {}
): Promise<void> {
  const { follow, json, container, tailLines, sinceSeconds } =
    normalizeAgentPodLogsOptions(options);

  const params = new URLSearchParams({
    container,
    tailLines: String(tailLines),
    sinceSeconds: String(sinceSeconds),
    follow: String(follow),
  });
  const path = `/api/v1/agent-ops/agents/${agentId}/pod-logs?${params}`;

  if (follow) {
    await streamPodLogs(client, path, json);
  } else {
    const response = await client.request<Record<string, unknown>>(path);
    if (!response.ok) {
      throw new Error(
        withRequestId(
          extractErrorDetail(response.data) || `Failed to fetch pod logs (HTTP ${response.status})`,
          response
        )
      );
    }
    const { logs, pod_name } = extractPodLogs(response.data);
    if (json) {
      process.stdout.write(JSON.stringify({ pod_name, logs }, null, 2) + "\n");
    } else if (logs.length === 0) {
      process.stdout.write(
        "No pod log lines returned for the selected window (pod may have no output yet).\n"
      );
    } else {
      if (pod_name) {
        process.stdout.write(`${DIM}Pod:${RESET} ${pod_name}\n\n`);
      }
      for (const entry of logs) {
        process.stdout.write(formatPodLogLine(entry) + "\n");
      }
      process.stdout.write(`\n${logs.length} lines\n`);
    }
  }
}

async function streamPodLogs(client: GalaxyHttpClient, path: string, json: boolean): Promise<void> {
  let attempt = 0;

  while (attempt <= SSE_MAX_RECONNECT_ATTEMPTS) {
    try {
      await streamPodLogsOnce(client, path, json);
      return;
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;

      attempt++;
      if (attempt > SSE_MAX_RECONNECT_ATTEMPTS) {
        throw new Error(
          `Pod log stream disconnected after ${SSE_MAX_RECONNECT_ATTEMPTS} reconnect attempts: ` +
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

async function streamPodLogsOnce(
  client: GalaxyHttpClient,
  path: string,
  json: boolean
): Promise<void> {
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
      `Failed to connect to pod log stream (HTTP ${response.status}) (request ID: ${requestId})`
    );
  }

  if (!response.body) {
    throw new NonRetryableError("No response body for SSE stream");
  }

  process.stdout.write("Connected to pod log stream. Press Ctrl+C to stop.\n\n");

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
          if (payload === "{}" || payload.trim() === "") continue;
          try {
            const parsed = PodLogLineSchema.safeParse(JSON.parse(payload));
            if (!parsed.success) {
              process.stdout.write(`${DIM}[malformed pod log line skipped]${RESET} ${payload}\n`);
              continue;
            }
            const entry = parsed.data;
            if (json) {
              process.stdout.write(JSON.stringify(entry) + "\n");
            } else {
              process.stdout.write(formatPodLogLine(entry) + "\n");
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
