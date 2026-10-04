/**
 * novaos-cli — MCP Tool Invocation
 *
 * Provides `novaos-cli mcp invoke` to call an MCP tool via the sandbox gateway
 * using the JSON-RPC 2.0 protocol.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MCP_GATEWAY_URL = "http://localhost:4000";
const MCP_INVOKE_TIMEOUT_MS = 30_000;
const JSON_RPC_VERSION = "2.0";
const JSON_RPC_REQUEST_ID = 1;

const EXIT_SUCCESS = 0;
const EXIT_MCP_ERROR = 1;
const EXIT_NETWORK_ERROR = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpInvokeOptions {
  tool: string;
  input?: string;
  gatewayUrl?: string;
  json?: boolean;
  token?: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: { name: string; arguments: unknown };
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Request builder (exported for testing)
// ---------------------------------------------------------------------------

export function buildJsonRpcRequest(toolName: string, args: unknown): JsonRpcRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: JSON_RPC_REQUEST_ID,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function formatResult(result: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);

  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const entries = Object.entries(result as Record<string, unknown>);
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
    return entries.map(([k, v]) => `  ${k.padEnd(maxKeyLen)}  ${JSON.stringify(v)}`).join("\n");
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Main invoke
// ---------------------------------------------------------------------------

export async function mcpInvoke(options: McpInvokeOptions): Promise<{ exitCode: number }> {
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_MCP_GATEWAY_URL;
  const asJson = options.json ?? false;

  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(options.input ?? "{}");
  } catch (err) {
    process.stderr.write(
      `Invalid --input JSON: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { exitCode: EXIT_NETWORK_ERROR };
  }

  const rpcRequest = buildJsonRpcRequest(options.tool, parsedInput);
  const url = `${gatewayUrl}/mcp/v1/tools/call`;

  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(gatewayUrl);
  if (!isLocalhost && !options.token) {
    process.stderr.write(
      `Warning: targeting non-localhost gateway without --token. The request may be rejected.\n`
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpcRequest),
      signal: AbortSignal.timeout(MCP_INVOKE_TIMEOUT_MS),
    });
  } catch (err) {
    process.stderr.write(`Network error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: EXIT_NETWORK_ERROR };
  }

  let rpcResponse: JsonRpcResponse;
  try {
    rpcResponse = (await res.json()) as JsonRpcResponse;
  } catch (err) {
    process.stderr.write(
      `Failed to parse gateway response: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { exitCode: EXIT_NETWORK_ERROR };
  }

  if (rpcResponse.error) {
    process.stderr.write(`MCP error (${rpcResponse.error.code}): ${rpcResponse.error.message}\n`);
    if (rpcResponse.error.data) {
      process.stderr.write(`  Data: ${JSON.stringify(rpcResponse.error.data)}\n`);
    }
    return { exitCode: EXIT_MCP_ERROR };
  }

  process.stdout.write(formatResult(rpcResponse.result, asJson) + "\n");
  return { exitCode: EXIT_SUCCESS };
}
