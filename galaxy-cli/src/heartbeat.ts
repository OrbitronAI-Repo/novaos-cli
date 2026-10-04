/**
 * novaos-cli — Heartbeat Commands
 *
 * Provides:
 *   novaos-cli heartbeat list   --agent-id <id> [--json]
 *   novaos-cli heartbeat status --agent-id <id> [--json]
 *   novaos-cli heartbeat create --agent-id <id> --schedule <cron> --workflow <name> [--json]
 *
 * Targets Agent Ops service (/api/v1/agent-ops/agents/<id>/heartbeat).
 * The Heartbeat service is not yet deployed — these commands handle
 * 404/501 gracefully with a user-friendly notice.
 */

import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_API_PREFIX = "/api/v1/agent-ops/agents";
const PLATFORM_NOT_AVAILABLE_MSG =
  "Heartbeat service is not yet available. This command will work once the Heartbeat service is deployed.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatListOptions {
  agentId: string;
  json?: boolean;
}

export interface HeartbeatStatusOptions {
  agentId: string;
  json?: boolean;
}

export interface HeartbeatCreateOptions {
  agentId: string;
  schedule: string;
  workflow: string;
  json?: boolean;
}

export interface HeartbeatConfig {
  id: string;
  schedule: string;
  workflow: string;
  enabled: boolean;
  created_at?: string;
}

export interface HeartbeatListResult {
  configs: HeartbeatConfig[];
}

export interface HeartbeatStatusResult {
  agent_id: string;
  last_heartbeat_at?: string;
  status: string;
  active_configs: number;
}

export interface HeartbeatCreateResult {
  success: boolean;
  message: string;
  config?: HeartbeatConfig;
}

interface AgentOpsResponse<T> {
  data: T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function isPlatformUnavailable(status: number): boolean {
  return status === 404 || status === 501;
}

function heartbeatPath(agentId: string, suffix: string): string {
  return `${HEARTBEAT_API_PREFIX}/${encodeURIComponent(agentId)}/heartbeat/${suffix}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function heartbeatList(
  client: GalaxyHttpClient,
  opts: HeartbeatListOptions
): Promise<HeartbeatListResult> {
  const response = await client.request<AgentOpsResponse<HeartbeatListResult>>(
    heartbeatPath(opts.agentId, "configs")
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({ configs: [], notice: PLATFORM_NOT_AVAILABLE_MSG });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return { configs: [] };
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to list heartbeat configs: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;

  if (opts.json) {
    printJson(result);
  } else {
    const configs = result.configs ?? [];
    if (configs.length === 0) {
      process.stdout.write("No heartbeat configurations found.\n");
    } else {
      for (const cfg of configs) {
        const state = cfg.enabled ? "enabled" : "disabled";
        process.stdout.write(`  ${cfg.id}  ${cfg.schedule}  ${cfg.workflow}  [${state}]\n`);
      }
    }
  }

  return result;
}

export async function heartbeatStatus(
  client: GalaxyHttpClient,
  opts: HeartbeatStatusOptions
): Promise<HeartbeatStatusResult> {
  const response = await client.request<AgentOpsResponse<HeartbeatStatusResult>>(
    heartbeatPath(opts.agentId, "status")
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({
        agent_id: opts.agentId,
        status: "unavailable",
        notice: PLATFORM_NOT_AVAILABLE_MSG,
      });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return { agent_id: opts.agentId, status: "unavailable", active_configs: 0 };
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to get heartbeat status: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;

  if (opts.json) {
    printJson(result);
  } else {
    process.stdout.write(`Agent:          ${result.agent_id}\n`);
    process.stdout.write(`Status:         ${result.status}\n`);
    process.stdout.write(`Active Configs: ${result.active_configs}\n`);
    if (result.last_heartbeat_at) {
      process.stdout.write(`Last Heartbeat: ${result.last_heartbeat_at}\n`);
    }
  }

  return result;
}

export async function heartbeatCreate(
  client: GalaxyHttpClient,
  opts: HeartbeatCreateOptions
): Promise<HeartbeatCreateResult> {
  const response = await client.request<AgentOpsResponse<HeartbeatCreateResult>>(
    heartbeatPath(opts.agentId, "configs"),
    {
      method: "POST",
      body: {
        schedule: opts.schedule,
        workflow: opts.workflow,
      },
    }
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({ success: false, notice: PLATFORM_NOT_AVAILABLE_MSG });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return { success: false, message: PLATFORM_NOT_AVAILABLE_MSG };
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to create heartbeat config: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;

  if (opts.json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(`Heartbeat config created for agent ${opts.agentId}\n`);
    process.stdout.write(`  Schedule: ${opts.schedule}\n`);
    process.stdout.write(`  Workflow: ${opts.workflow}\n`);
  } else {
    process.stderr.write(`Heartbeat config creation failed: ${result.message}\n`);
  }

  return result;
}
