/**
 * novaos-cli — Shadow Testing Commands
 *
 * Provides:
 *   novaos-cli shadow deploy   --agent <id> --version <v> --url <url> [--traffic-pct N] [--eval-config <json>]
 *   novaos-cli shadow promote  --agent <id> --version <v>
 *   novaos-cli shadow rollback --agent <id>
 *   novaos-cli shadow replay   --agent <id> --version <v> [--count N] [--from-date <ISO>]
 *   novaos-cli shadow summary  --agent <id> --version <v> [--json]
 *
 * All commands target the AgentOps service (/api/v1/agent-ops/shadow/*).
 * Use --json for machine-readable output (CI/CD pipelines).
 */

import { randomUUID } from "node:crypto";

import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHADOW_API_PREFIX = "/api/v1/agent-ops/shadow";
const DEFAULT_TRAFFIC_PCT = 10;
const DEFAULT_REPLAY_COUNT = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShadowEvaluationConfig {
  correctness_mode?: "exact_match" | "semantic_similarity" | "llm_judge";
  correctness_threshold?: number;
  latency_threshold_p95_ms?: number;
  cost_increase_threshold_pct?: number;
  min_sample_size?: number;
}

export interface ShadowDeployOptions {
  agentId: string;
  shadowVersion: string;
  shadowUrl: string;
  trafficPct?: number;
  evaluationConfig?: ShadowEvaluationConfig;
  json?: boolean;
}

export interface ShadowPromoteOptions {
  agentId: string;
  shadowVersion: string;
  json?: boolean;
}

export interface ShadowRollbackOptions {
  agentId: string;
  json?: boolean;
}

export interface ShadowReplayOptions {
  agentId: string;
  shadowVersion: string;
  count?: number;
  fromDate?: string;
  json?: boolean;
}

export interface ShadowSummaryOptions {
  agentId: string;
  shadowVersion: string;
  json?: boolean;
}

export interface ShadowDeployResult {
  success: boolean;
  message: string;
  shadow_version?: string;
  traffic_pct?: number;
}

export interface ShadowPromoteResult {
  success: boolean;
  message: string;
  promoted_version?: string;
}

export interface ShadowRollbackResult {
  success: boolean;
  message: string;
}

export interface ShadowReplayResult {
  success: boolean;
  message: string;
  replayed?: number;
}

export interface ShadowSummaryData {
  agent_id: string;
  shadow_version: string;
  status: string;
  traffic_pct: number;
  total_executions: number;
  correctness_score?: number;
  latency_p95_ms?: number;
  cost_delta_pct?: number;
  started_at?: string;
  last_updated_at?: string;
}

interface AgentOpsResponse<T> {
  data: T;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function assertResult<T>(data: T | null | undefined, action: string): asserts data is T {
  if (data == null) {
    throw new Error(`${action}: received empty response from server`);
  }
}

function printSummaryTable(s: ShadowSummaryData): void {
  const rows: Array<[string, string]> = [
    ["Agent", s.agent_id],
    ["Shadow Version", s.shadow_version],
    ["Status", s.status],
    ["Traffic %", String(s.traffic_pct)],
    ["Total Requests", String(s.total_executions)],
  ];

  if (s.correctness_score !== undefined) {
    rows.push(["Correctness", `${(s.correctness_score * 100).toFixed(1)}%`]);
  }
  if (s.latency_p95_ms !== undefined) {
    rows.push(["Latency p95", `${s.latency_p95_ms}ms`]);
  }
  if (s.cost_delta_pct !== undefined) {
    rows.push(["Cost Delta", `${s.cost_delta_pct > 0 ? "+" : ""}${s.cost_delta_pct}%`]);
  }
  if (s.started_at) {
    rows.push(["Started At", s.started_at]);
  }
  if (s.last_updated_at) {
    rows.push(["Last Updated", s.last_updated_at]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;

  for (const [label, value] of rows) {
    process.stdout.write(`${(label + ":").padEnd(labelWidth)}  ${value}\n`);
  }
}

// ---------------------------------------------------------------------------
// Shadow Commands
//
// Library functions — throw on failure, return result objects.
// The CLI entry point maps errors to process.exit() codes.
// ---------------------------------------------------------------------------

/**
 * novaos-cli shadow deploy --agent <id> --version <v> --url <url>
 *
 * Deploys a shadow version alongside the production agent, routing a
 * percentage of traffic for A/B comparison.
 */
export async function shadowDeploy(
  client: GalaxyHttpClient,
  opts: ShadowDeployOptions
): Promise<ShadowDeployResult> {
  const response = await client.request<AgentOpsResponse<ShadowDeployResult>>(
    `${SHADOW_API_PREFIX}/deploy`,
    {
      method: "POST",
      body: {
        agent_id: opts.agentId,
        shadow_version: opts.shadowVersion,
        shadow_url: opts.shadowUrl,
        traffic_pct: opts.trafficPct ?? DEFAULT_TRAFFIC_PCT,
        evaluation_config: opts.evaluationConfig,
      },
      headers: {
        "X-Idempotency-Key": `${opts.agentId}:${opts.shadowVersion}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to deploy shadow: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;
  assertResult(result, "Shadow deploy");

  if (opts.json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(
      `Shadow deployed: ${opts.agentId} v${opts.shadowVersion} @ ${opts.trafficPct ?? DEFAULT_TRAFFIC_PCT}% traffic\n`
    );
  } else {
    process.stderr.write(`Shadow deploy failed: ${result.message}\n`);
  }

  return result;
}

/**
 * novaos-cli shadow promote --agent <id> --version <v>
 *
 * Promotes the shadow version to replace the current production version.
 */
export async function shadowPromote(
  client: GalaxyHttpClient,
  opts: ShadowPromoteOptions
): Promise<ShadowPromoteResult> {
  const response = await client.request<AgentOpsResponse<ShadowPromoteResult>>(
    `${SHADOW_API_PREFIX}/promote`,
    {
      method: "POST",
      body: {
        agent_id: opts.agentId,
        shadow_version: opts.shadowVersion,
      },
      headers: {
        "X-Idempotency-Key": `${opts.agentId}:${opts.shadowVersion}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to promote shadow: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;
  assertResult(result, "Shadow promote");

  if (opts.json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(
      `Shadow promoted: ${opts.agentId} v${opts.shadowVersion} is now production\n`
    );
  } else {
    process.stderr.write(`Shadow promotion blocked: ${result.message}\n`);
  }

  return result;
}

/**
 * novaos-cli shadow rollback --agent <id>
 *
 * Removes the active shadow deployment, restoring 100% traffic to production.
 */
export async function shadowRollback(
  client: GalaxyHttpClient,
  opts: ShadowRollbackOptions
): Promise<ShadowRollbackResult> {
  const response = await client.request<AgentOpsResponse<ShadowRollbackResult>>(
    `${SHADOW_API_PREFIX}/rollback`,
    {
      method: "POST",
      body: {
        agent_id: opts.agentId,
      },
      // Stable per-agent, not per-invocation: rollback ("restore 100% production
      // traffic") is naturally idempotent, so a repeat call — whether a retry of
      // this attempt or a deliberate second rollback — is safe to dedupe against
      // the same key.
      headers: {
        "X-Idempotency-Key": opts.agentId,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to rollback shadow: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;
  assertResult(result, "Shadow rollback");

  if (opts.json) {
    printJson(result);
  } else {
    process.stdout.write(
      result.success
        ? `Shadow rolled back: ${opts.agentId} — 100% traffic restored to production\n`
        : `Shadow rollback failed: ${result.message}\n`
    );
  }

  return result;
}

/**
 * novaos-cli shadow replay --agent <id> --version <v> [--count N] [--from-date <ISO>]
 *
 * Replays historical production requests through the shadow version for offline evaluation.
 */
export async function shadowReplay(
  client: GalaxyHttpClient,
  opts: ShadowReplayOptions
): Promise<ShadowReplayResult> {
  const response = await client.request<AgentOpsResponse<ShadowReplayResult>>(
    `${SHADOW_API_PREFIX}/replay`,
    {
      method: "POST",
      body: {
        agent_id: opts.agentId,
        shadow_version: opts.shadowVersion,
        count: opts.count ?? DEFAULT_REPLAY_COUNT,
        from_date: opts.fromDate,
      },
      // Unlike deploy/promote/rollback, replaying the same agent+version is a
      // legitimate repeatable action (queue another batch), not a one-time
      // state transition — so the key must be generated fresh per invocation
      // (retries of *this* call still share it, since it's computed once,
      // before GalaxyHttpClient's retry loop) rather than derived from params,
      // or two deliberately separate replay requests would collide.
      headers: {
        "X-Idempotency-Key": randomUUID(),
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to start shadow replay: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;
  assertResult(result, "Shadow replay");

  if (opts.json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(
      `Replay started: ${opts.agentId} v${opts.shadowVersion} — ${result.replayed ?? opts.count ?? DEFAULT_REPLAY_COUNT} requests queued\n`
    );
  } else {
    process.stderr.write(`Shadow replay failed: ${result.message}\n`);
  }

  return result;
}

/**
 * novaos-cli shadow summary --agent <id> --version <v> [--json]
 *
 * Retrieves the evaluation summary for a shadow deployment.
 */
export async function shadowSummary(
  client: GalaxyHttpClient,
  opts: ShadowSummaryOptions
): Promise<ShadowSummaryData> {
  const response = await client.request<AgentOpsResponse<ShadowSummaryData>>(
    `${SHADOW_API_PREFIX}/${encodeURIComponent(opts.agentId)}/${encodeURIComponent(opts.shadowVersion)}/summary`
  );

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to fetch shadow summary: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const summary = response.data.data;

  if (opts.json) {
    printJson(summary);
  } else {
    printSummaryTable(summary);
  }

  return summary;
}
