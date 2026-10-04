/**
 * novaos-cli — MCP tool server pod logs (stdout/stderr via MCP Ops + K8s).
 *
 * Calls GET /api/v1/mcp-ops/services/:serviceId/pod-logs with optional SSE follow.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { getAccessToken, getIdToken } from "./auth.js";
import { USER_AGENT, REQUEST_TIMEOUT_MS } from "./constants.js";
import { withRequestId, type GalaxyHttpClient } from "./http-client.js";

const PodLogLineSchema = z.object({
  timestamp: z.string().nullable(),
  line: z.string(),
});

type PodLogLine = z.infer<typeof PodLogLineSchema>;

const PodLogsDataSchema = z.object({
  logs: z.array(PodLogLineSchema),
  pod_name: z.string().optional(),
});

interface McpPodLogsOptions {
  follow?: boolean;
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  json?: boolean;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const DEFAULT_CONTAINER = "mcp-server";
const DEFAULT_TAIL_LINES = 100;

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

function unwrapPodLogsBody(body: unknown): z.infer<typeof PodLogsDataSchema> | null {
  if (body === null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const inner = obj.data !== undefined ? obj.data : obj;
  const parsed = PodLogsDataSchema.safeParse(inner);
  return parsed.success ? parsed.data : null;
}

function formatPodLine(entry: PodLogLine): string {
  const ts = entry.timestamp ? `${DIM}${entry.timestamp}${RESET} ` : "";
  return `${ts}${entry.line}`;
}

/**
 * Fetch MCP tool pod logs for a Service Registry service_id (UUID).
 */
export async function mcpPodLogs(
  client: GalaxyHttpClient,
  serviceId: string,
  options: McpPodLogsOptions
): Promise<void> {
  const {
    follow = false,
    container = DEFAULT_CONTAINER,
    tailLines = DEFAULT_TAIL_LINES,
    sinceSeconds,
    json = false,
  } = options;

  const params = new URLSearchParams({
    follow: String(follow),
    container,
    tailLines: String(tailLines),
  });
  if (sinceSeconds !== undefined) {
    params.set("sinceSeconds", String(sinceSeconds));
  }

  const path = `/api/v1/mcp-ops/services/${encodeURIComponent(serviceId)}/pod-logs?${params}`;

  if (follow) {
    await streamMcpPodLogs(client, path, json);
  } else {
    const response = await client.request<Record<string, unknown>>(path);
    if (!response.ok) {
      const errorData = response.data as {
        errors?: { detail?: string; title?: string }[] | null;
      };
      const err0 = errorData.errors?.[0];
      throw new Error(
        withRequestId(
          err0?.detail ?? err0?.title ?? `Failed to fetch MCP pod logs (HTTP ${response.status})`,
          response
        )
      );
    }
    const data = unwrapPodLogsBody(response.data);
    if (!data) {
      throw new Error("mcp-ops pod-logs response failed validation");
    }
    if (json) {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } else if (data.logs.length === 0) {
      process.stdout.write("No log lines returned for this pod (tail window may be empty).\n");
    } else {
      if (data.pod_name) {
        process.stdout.write(`${DIM}pod:${RESET} ${data.pod_name}\n\n`);
      }
      for (const entry of data.logs) {
        process.stdout.write(formatPodLine(entry) + "\n");
      }
      process.stdout.write(`\n${data.logs.length} lines\n`);
    }
  }
}

async function streamMcpPodLogs(
  client: GalaxyHttpClient,
  path: string,
  json: boolean
): Promise<void> {
  let attempt = 0;
  while (attempt <= SSE_MAX_RECONNECT_ATTEMPTS) {
    try {
      await streamMcpPodLogsOnce(client, path, json);
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

async function streamMcpPodLogsOnce(
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
      `Failed to connect to MCP pod log stream (HTTP ${response.status}) (request ID: ${requestId})`
    );
  }

  if (!response.body) {
    throw new NonRetryableError("No response body for SSE stream");
  }

  process.stdout.write("Connected to MCP pod log stream. Press Ctrl+C to stop.\n\n");

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
            const parsed = PodLogLineSchema.safeParse(JSON.parse(payload));
            if (!parsed.success) {
              process.stdout.write(`${DIM}[malformed line skipped]${RESET} ${payload}\n`);
              continue;
            }
            const entry = parsed.data;
            if (json) {
              process.stdout.write(JSON.stringify(entry) + "\n");
            } else {
              process.stdout.write(formatPodLine(entry) + "\n");
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
