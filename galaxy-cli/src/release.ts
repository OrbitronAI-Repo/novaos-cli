/**
 * novaos-cli — Release Management Commands
 *
 * Provides:
 *   novaos-cli release create   --agent <id> --channel <canary|beta|stable> --version <semver>
 *   novaos-cli release list     --agent <id> [--json]
 *
 * All commands target the AgentOps service (/api/v1/agent-ops/*).
 * Use --json for machine-readable output (CI/CD pipelines).
 */

import { z } from "zod";

import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CHANNELS = ["canary", "beta", "stable"] as const;
type ReleaseChannel = (typeof VALID_CHANNELS)[number];

const MIN_COL_VERSION_WIDTH = 14;
const MIN_COL_CHANNEL_WIDTH = 8;
const MIN_COL_STATUS_WIDTH = 12;
const MIN_COL_CREATED_AT_WIDTH = 24;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseCreateOptions {
  agentId: string;
  channel: ReleaseChannel;
  version: string;
  imageRef?: string;
  json?: boolean;
}

export interface ReleaseListOptions {
  agentId: string;
  json?: boolean;
}

export interface ReleaseEntry {
  agentId: string;
  version: string;
  channel: string;
  status: string;
  createdAt: string;
}

interface AgentOpsResponse<T> {
  data: T;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ChannelSchema = z.enum(VALID_CHANNELS);

function assertValidChannel(channel: string): asserts channel is ReleaseChannel {
  ChannelSchema.parse(channel);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function printTable(rows: ReleaseEntry[]): void {
  if (rows.length === 0) {
    process.stdout.write("No releases found.\n");
    return;
  }

  const colWidths = {
    version: Math.max(MIN_COL_VERSION_WIDTH, ...rows.map((r) => r.version.length)),
    channel: Math.max(MIN_COL_CHANNEL_WIDTH, ...rows.map((r) => r.channel.length)),
    status: Math.max(MIN_COL_STATUS_WIDTH, ...rows.map((r) => r.status.length)),
    createdAt: Math.max(MIN_COL_CREATED_AT_WIDTH, ...rows.map((r) => r.createdAt.length)),
  };

  const header = [
    "VERSION".padEnd(colWidths.version),
    "CHANNEL".padEnd(colWidths.channel),
    "STATUS".padEnd(colWidths.status),
    "CREATED_AT".padEnd(colWidths.createdAt),
  ].join("  ");

  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");

  for (const row of rows) {
    process.stdout.write(
      [
        row.version.padEnd(colWidths.version),
        row.channel.padEnd(colWidths.channel),
        row.status.padEnd(colWidths.status),
        row.createdAt.padEnd(colWidths.createdAt),
      ].join("  ") + "\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Release Commands
//
// Design: these are library functions — they throw errors on failure or return
// result objects. The CLI entry point (command parser) is the ONLY place that
// maps errors to process.exit() codes. This makes the functions testable
// without mocking process.exit and safe for programmatic use.
// ---------------------------------------------------------------------------

/**
 * novaos-cli release create --agent <id> --channel <channel> --version <version>
 *
 * Registers a new agent version in the specified release channel via AgentOps.
 */
export async function releaseCreate(
  client: GalaxyHttpClient,
  opts: ReleaseCreateOptions
): Promise<void> {
  process.stderr.write(
    "DEPRECATION: 'novaos-cli release create' is deprecated. Use 'novaos-cli publish <manifest-path>' instead.\n" +
      "This command will be removed in a future release.\n\n"
  );

  assertValidChannel(opts.channel);

  const response = await client.request<AgentOpsResponse<ReleaseEntry>>(
    `/api/v1/agent-ops/releases`,
    {
      method: "POST",
      body: {
        agent_id: opts.agentId,
        version: opts.version,
        channel: opts.channel,
        image_ref: opts.imageRef,
      },
      headers: {
        "X-Idempotency-Key": `${opts.agentId}:${opts.channel}:${opts.version}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to create release: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const entry = response.data.data;

  if (!entry) {
    throw new Error("Release create: received empty response from server");
  }

  if (opts.json) {
    printJson(entry);
  } else {
    process.stdout.write(
      `✓ Release created: ${entry.agentId} v${entry.version} → ${entry.channel}\n`
    );
  }
}

/**
 * novaos-cli release list --agent <id>
 *
 * Lists all release versions for an agent across all channels via AgentOps.
 */
export async function releaseList(
  client: GalaxyHttpClient,
  opts: ReleaseListOptions
): Promise<void> {
  const response = await client.request<AgentOpsResponse<{ versions: ReleaseEntry[] }>>(
    `/api/v1/agent-ops/agents/${opts.agentId}/versions`
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to list releases: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const entries: ReleaseEntry[] = response.data.data?.versions ?? [];

  if (opts.json) {
    printJson(entries);
  } else {
    printTable(entries);
  }
}
