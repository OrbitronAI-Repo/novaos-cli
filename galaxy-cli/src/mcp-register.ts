/**
 * novaos-cli mcp register — Register an MCP tool server from a local manifest.
 *
 * Reads the manifest, validates it locally, then POSTs to the MCP-Ops
 * services/import endpoint to register the service and its tools.
 */

import { readFileSync } from "fs";

import { z } from "zod";

import { withRequestId, type GalaxyHttpClient } from "./http-client.js";
import { validateMcpManifest } from "./mcp-manifest.js";

interface McpRegisterOptions {
  manifestPath: string;
  /**
   * Runtime URL of the already-deployed MCP tool server. `register` (unlike
   * `publish`) points at a server that already exists, so the platform has
   * no other way to learn its address — the manifest schema itself leaves
   * `url` optional because `mcp init` scaffolds manifests for `publish`,
   * where the server assigns the URL after deployment. Overrides
   * manifest.url when both are present.
   */
  url?: string;
  environment?: string;
  json?: boolean;
}

export async function mcpRegister(
  client: GalaxyHttpClient,
  options: McpRegisterOptions
): Promise<void> {
  const { manifestPath, url, environment = "production", json = false } = options;

  const raw = readFileSync(manifestPath, "utf-8");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}`);
  }

  if (url) {
    manifest.url = url;
  }

  const validation = validateMcpManifest(manifest);
  if (!validation.valid) {
    const errors = validation.errors ?? [];
    const msg = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Manifest validation failed:\n${msg}`);
  }

  const urlCheck = z.string().url().safeParse(manifest.url);
  if (!urlCheck.success) {
    throw new Error(
      "Registration failed: the manifest has no runtime url for the already-deployed server.\n" +
        '  "mcp register" targets a server that is already running elsewhere — pass its address ' +
        'with --url <url>, or add a "url" field to the manifest.'
    );
  }

  const response = await client.request<{ data: unknown }>("/api/v1/mcp-ops/services/import", {
    method: "POST",
    body: { manifest, environment },
  });

  if (!response.ok) {
    const detail =
      typeof response.data === "object" && response.data !== null
        ? JSON.stringify(response.data)
        : typeof response.data === "string"
          ? response.data
          : "";
    throw new Error(
      withRequestId(
        `Registration failed: ${response.status}${detail ? ` — ${detail}` : ""}`,
        response
      )
    );
  }

  const result = response.data.data ?? response.data;

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const name = validation.manifest?.name ?? "unknown";
    process.stdout.write(`MCP tool server '${name}' registered successfully.\n`);
    process.stdout.write(`Environment: ${environment}\n`);
  }
}
