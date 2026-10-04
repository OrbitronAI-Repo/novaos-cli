/**
 * novaos-cli — A2A client helpers for local dev-loop commands
 *
 * `run` and `eval local` both talk to a bare `python3 -m uvicorn` / `bun run
 * start` / `./mvnw spring-boot:run` process on localhost — no auth-proxy
 * sidecar, no execution token, no fleet/HITL/file-artifact handling. This
 * module builds the one A2A `SendMessage` round trip those two commands need
 * on top of `@novaos-cli/shared/a2a`'s wire layer (the same JSON-RPC
 * envelope, headers, and response parsers the platform's own pod-callers —
 * `mint-and-execute.ts`, the gateway adapter — use) instead of re-deriving the
 * A2A contract from scratch.
 */

import { randomUUID } from "node:crypto";

import {
  A2A_JSONRPC_PATH,
  A2A_METHODS,
  A2A_ROLE,
  JsonRpcResponseSchema,
  a2aVersionHeader,
  buildA2AParts,
  buildSendMessageRequest,
  describeA2ATransportFailure,
  drainParts,
  parseTaskResponse,
  type NovaosPartExtract,
} from "@novaos-cli/shared/a2a";

export interface A2ASendMessageResult {
  status: number;
  /** Raw response body text, whether or not it parsed as JSON. */
  raw: string;
  /** Parsed JSON body, when the response was valid JSON. */
  body?: unknown;
  /** The `traceparent` response header, if the agent sent one. */
  traceparent?: string;
  /** Set when the HTTP transport itself failed (non-2xx status). */
  transportError?: string;
  /** Set when the response was a well-formed JSON-RPC error envelope. */
  rpcError?: { code: number; message: string };
}

/** The agent pod's A2A JSON-RPC endpoint, given its base URL (scheme+host[:port]). */
export function agentJsonRpcUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${A2A_JSONRPC_PATH}`;
}

/**
 * Send one A2A v1.0 `SendMessage` request carrying `text` as the sole message
 * part, and classify the result into a transport failure, a JSON-RPC error, or
 * a parsed success body.
 */
export async function sendA2AMessage(
  baseUrl: string,
  text: string,
  opts?: { timeoutMs?: number }
): Promise<A2ASendMessageResult> {
  const requestBody = buildSendMessageRequest({
    method: A2A_METHODS.SEND_MESSAGE,
    requestId: randomUUID(),
    message: {
      messageId: randomUUID(),
      role: A2A_ROLE.USER,
      parts: buildA2AParts(text),
    },
  });

  const res = await fetch(agentJsonRpcUrl(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...a2aVersionHeader(),
    },
    body: JSON.stringify(requestBody),
    signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });

  const raw = await res.text();
  const traceparent = res.headers.get("traceparent") ?? undefined;

  if (!res.ok) {
    return {
      status: res.status,
      raw,
      traceparent,
      transportError: describeA2ATransportFailure(res.status, res.statusText, raw),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: res.status, raw, traceparent };
  }

  const envelope = JsonRpcResponseSchema.safeParse(body);
  if (envelope.success && envelope.data.error) {
    return {
      status: res.status,
      raw,
      body,
      traceparent,
      rpcError: {
        code: envelope.data.error.code,
        message: envelope.data.error.message ?? `JSON-RPC error ${envelope.data.error.code}`,
      },
    };
  }

  return { status: res.status, raw, body, traceparent };
}

/**
 * Best-effort extraction of the agent's displayable text from a parsed
 * `SendMessage` response body: an artifact's text, falling back to the task's
 * status message, or a bare `Message` result's own parts.
 *
 * Deliberately not a full reimplementation of the platform's
 * `interpretTerminalTask` (`packages/temporal-worker/src/activities/mint-and-execute.ts`)
 * — no file/HITL/dedup handling, since none of that applies to a local
 * request against a plain scaffolded agent. This is just enough to score or
 * print what the agent actually said.
 *
 * Returns `undefined` when the body carries a JSON-RPC error or matches
 * neither a `Task` nor a `Message` result shape.
 */
export function extractA2AResponseText(body: unknown): string | undefined {
  const parsed = parseTaskResponse(body);
  if (!parsed || parsed.kind === "error") return undefined;

  const extract: NovaosPartExtract = {};

  if (parsed.kind === "message") {
    return drainParts(parsed.message.parts, extract).texts.join("");
  }

  const texts: string[] = [];
  for (const artifact of parsed.task.artifacts ?? []) {
    texts.push(...drainParts(artifact.parts, extract).texts);
  }
  if (texts.length === 0) {
    texts.push(...drainParts(parsed.task.status.message?.parts, extract).texts);
  }
  return texts.join("");
}
