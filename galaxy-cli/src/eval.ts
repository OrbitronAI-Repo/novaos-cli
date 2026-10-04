/**
 * novaos-cli — Evaluation Commands
 *
 * Provides:
 *   novaos-cli eval run   --suite <suite-id> --agent-version <semver> [--outputs-file <path>] [--json]
 *   novaos-cli eval list  --agent <id> [--limit <n>] [--suite-id <id>] [--json]
 *
 * `eval run` triggers a suite run on the Evaluation Engine and exits non-zero
 * if the suite fails, making it suitable as a CI/CD quality gate.
 *
 * HTTP client contract:
 *   `client.request<T>()` returns `ApiResponse<T>` where `data` is the raw
 *   JSON response body cast as T. The HTTP client does NOT unwrap any envelope.
 *   See release.ts JSDoc for the known gap documentation.
 */

import { readFileSync } from "node:fs";

import { stringifyError } from "@novaos-cli/shared/utils";
import { z } from "zod";

import { DEFAULT_REGRESSION_THRESHOLD, EXIT_REGRESSION } from "./constants.js";
import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;
const DEFAULT_EVAL_LIST_LIMIT = 20;

const EVAL_ENGINE_UNREACHABLE_HINT = [
  "",
  "Suite evaluation requires platform-ops access. Use `novaos-cli eval local` for developer-side evaluation.",
  "",
  "The Evaluation Engine is cluster-internal by design (GDPR data boundary).",
  "For platform operators with cluster access, use kubectl port-forward.",
].join("\n");

const HTTP_NOT_FOUND = 404;

const MIN_COL_RUN_ID_WIDTH = 38;
const MIN_COL_SUITE_WIDTH = 20;
const MIN_COL_VERSION_WIDTH = 12;

// ---------------------------------------------------------------------------
// Zod schemas — runtime validation for API responses and file inputs
// ---------------------------------------------------------------------------

const EvalRunApiResponseSchema = z.object({
  run_id: z.string(),
  suite_id: z.string(),
  agent_version: z.string(),
  overall_score: z.number().nullable(),
  passed: z.boolean().nullable(),
  case_results: z.array(z.unknown()).default([]),
});

const EvalListApiItemSchema = z.object({
  run_id: z.string(),
  suite_id: z.string(),
  suite_name: z.string().nullable().optional(),
  agent_version: z.string(),
  overall_score: z.number().nullable(),
  passed: z.boolean().nullable(),
  created_at: z.string(),
});

const EvalListApiResponseSchema = z.object({
  data: z.array(EvalListApiItemSchema).default([]),
  next_cursor: z.string().nullable().optional(),
  total: z.number().default(0),
});

const EvalRunHistoryItemSchema = z.object({
  run_id: z.string(),
  overall_score: z.number().nullable(),
});

const CaseOutputsFileSchema = z.array(z.unknown());

const SUITE_RUNS_HISTORY_LIMIT = 5;

function validateThreshold(raw: number | undefined, defaultValue: number): number | null {
  if (raw == null) return defaultValue;
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalRunOptions {
  suiteId: string;
  agentVersion: string;
  outputsFile?: string;
  json?: boolean;
  detectRegression?: boolean;
  regressionThreshold?: number;
}

export interface EvalListOptions {
  agentId: string;
  suiteId?: string;
  limit?: number;
  cursor?: string;
  json?: boolean;
}

export interface EvalRunResult {
  runId: string;
  suiteId: string;
  agentVersion: string;
  overallScore: number | null;
  passed: boolean | null;
  caseResults: unknown[];
}

export interface EvalRunResponse {
  data: EvalRunResult | null;
  exitCode: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function extractSuiteRunsHistory(data: unknown): {
  runs: Array<{ run_id: string; overall_score: number }>;
  totalRaw: number;
  validCount: number;
} | null {
  const raw = (data as { data?: unknown })?.data ?? data;
  if (!Array.isArray(raw)) {
    return null;
  }

  const runs: Array<{ run_id: string; overall_score: number }> = [];
  let validCount = 0;
  for (const item of raw) {
    const parsed = EvalRunHistoryItemSchema.safeParse(item);
    if (parsed.success) {
      validCount++;
      if (parsed.data.overall_score !== null) {
        runs.push({ run_id: parsed.data.run_id, overall_score: parsed.data.overall_score });
      }
    }
  }
  return { runs, totalRaw: raw.length, validCount };
}

interface RegressionResult {
  exitCode: number | null;
  baseline?: { run_id: string; overall_score: number };
}

/**
 * Compare current run score against the most recent prior run.
 * Returns EXIT_REGRESSION when score drop exceeds threshold, otherwise null.
 */
export async function detectScoreRegression(
  client: GalaxyHttpClient,
  suiteId: string,
  currentRunId: string,
  currentScore: number,
  threshold: number,
  json = false
): Promise<RegressionResult> {
  let historyResp: { ok: boolean; status: number; data: unknown };
  try {
    historyResp = await client.request(
      `/api/v1/suites/${suiteId}/runs?limit=${SUITE_RUNS_HISTORY_LIMIT}`
    );
  } catch (error) {
    const msg = `Failed to fetch suite run history: ${stringifyError(error)}`;
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { exitCode: EXIT_ERROR };
  }

  if (!historyResp.ok) {
    const msg = withRequestId(`Suite run history returned HTTP ${historyResp.status}`, historyResp);
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { exitCode: EXIT_ERROR };
  }

  const parsedHistory = extractSuiteRunsHistory(historyResp.data);
  if (parsedHistory === null) {
    const msg = "Suite run history response has unexpected shape (not an array)";
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { exitCode: EXIT_ERROR };
  }

  if (parsedHistory.validCount === 0 && parsedHistory.totalRaw > 0) {
    const msg = "Suite run history items failed validation (none matched expected schema)";
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { exitCode: EXIT_ERROR };
  }

  const priorRuns = parsedHistory.runs.filter((run) => run.run_id !== currentRunId);

  if (priorRuns.length === 0) {
    if (!json) {
      process.stderr.write("No prior completed runs found — skipping regression check\n");
    }
    return { exitCode: null };
  }

  const baseline = priorRuns[0]!;
  const scoreDrop = baseline.overall_score - currentScore;
  if (scoreDrop > threshold) {
    if (!json) {
      process.stderr.write(
        `Error: Regression detected: score dropped by ${(scoreDrop * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)\n`
      );
      process.stderr.write(`  Baseline: ${baseline.overall_score} (run: ${baseline.run_id})\n`);
      process.stderr.write(`  Current:  ${currentScore}\n`);
    }
    return { exitCode: EXIT_REGRESSION, baseline };
  }

  return { exitCode: null, baseline };
}

// ---------------------------------------------------------------------------
// eval run
// ---------------------------------------------------------------------------

/**
 * Run an evaluation suite for a specific agent version.
 * Returns an exit code appropriate for use in CI/CD pipelines:
 *   0 — suite passed
 *   1 — suite failed (below threshold)
 *   2 — error (network, parse, config)
 *   3 — score regression detected (--detect-regression)
 */
export async function evalRun(
  client: GalaxyHttpClient,
  options: EvalRunOptions
): Promise<EvalRunResponse> {
  const { suiteId, agentVersion, outputsFile, json, detectRegression, regressionThreshold } =
    options;

  let caseOutputs: unknown[] = [];
  if (outputsFile) {
    try {
      const raw = readFileSync(outputsFile, "utf-8");
      const parsed = CaseOutputsFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(`Invalid case outputs format: ${parsed.error.message}`);
      }
      caseOutputs = parsed.data;
    } catch (error) {
      const msg = `Failed to read outputs file "${outputsFile}": ${stringifyError(error)}`;
      if (!json) {
        process.stderr.write(`Error: ${msg}\n`);
      }
      return { data: null, exitCode: EXIT_ERROR, message: msg };
    }
  }

  let response: { ok: boolean; status: number; data: unknown };
  try {
    response = await client.request(`/api/v1/suites/${suiteId}/run`, {
      method: "POST",
      body: {
        agent_version: agentVersion,
        triggered_by: "galaxy-cli",
        case_outputs: caseOutputs,
      },
    });
  } catch (error) {
    const msg = `Evaluation Engine request failed: ${stringifyError(error)}`;
    if (!json) {
      process.stderr.write(`Error: ${msg}\n${EVAL_ENGINE_UNREACHABLE_HINT}\n`);
    }
    return { data: null, exitCode: EXIT_ERROR, message: msg };
  }

  if (!response.ok) {
    const msg = withRequestId(`Evaluation Engine returned HTTP ${response.status}`, response);
    if (!json) {
      const suffix = response.status === HTTP_NOT_FOUND ? `\n${EVAL_ENGINE_UNREACHABLE_HINT}` : "";
      process.stderr.write(`Error: ${msg}${suffix}\n`);
    }
    return { data: null, exitCode: EXIT_ERROR, message: msg };
  }

  const parsed = EvalRunApiResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    const msg = `Unexpected response shape: ${parsed.error.message}`;
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { data: null, exitCode: EXIT_ERROR, message: msg };
  }

  const body = parsed.data;
  const result: EvalRunResult = {
    runId: body.run_id,
    suiteId: body.suite_id,
    agentVersion: body.agent_version,
    overallScore: body.overall_score,
    passed: body.passed,
    caseResults: body.case_results,
  };

  const scoreDisplay = result.overallScore !== null ? result.overallScore.toFixed(3) : "pending";
  let exitCode: number;
  let message: string;
  if (result.passed === null) {
    exitCode = EXIT_PASS;
    message = `Suite in progress (score: ${scoreDisplay})`;
  } else if (result.passed) {
    exitCode = EXIT_PASS;
    message = `Suite passed (score: ${scoreDisplay})`;
  } else {
    exitCode = EXIT_FAIL;
    message = `Suite failed (score: ${scoreDisplay})`;
  }

  let regressionResult:
    | { detected: boolean; baselineScore?: number; baselineRunId?: string; threshold?: number }
    | undefined;

  if (detectRegression && result.passed === true && result.overallScore !== null) {
    const threshold = validateThreshold(regressionThreshold, DEFAULT_REGRESSION_THRESHOLD);
    if (threshold === null) {
      const msg = `Invalid --regression-threshold: must be 0 <= t <= 1 (got ${regressionThreshold})`;
      if (json) {
        printJson({ ...result, error: msg });
      } else {
        process.stderr.write(`Error: ${msg}\n`);
      }
      return { data: result, exitCode: EXIT_ERROR, message: msg };
    }
    const regression = await detectScoreRegression(
      client,
      suiteId,
      result.runId,
      result.overallScore,
      threshold,
      json
    );
    if (regression.exitCode === EXIT_REGRESSION) {
      exitCode = EXIT_REGRESSION;
      message = `Regression detected (threshold: ${(threshold * 100).toFixed(1)}%)`;
      regressionResult = {
        detected: true,
        threshold,
        baselineScore: regression.baseline?.overall_score,
        baselineRunId: regression.baseline?.run_id,
      };
    } else if (regression.exitCode === EXIT_ERROR) {
      exitCode = EXIT_ERROR;
      message = "Regression check failed";
    } else {
      regressionResult = {
        detected: false,
        threshold,
        baselineScore: regression.baseline?.overall_score,
        baselineRunId: regression.baseline?.run_id,
      };
    }
  }

  if (json) {
    printJson({
      ...result,
      ...(regressionResult !== undefined ? { regression: regressionResult } : {}),
    });
  } else {
    const statusIcon = result.passed === null ? "…" : result.passed ? "✓" : "✗";
    const passedLabel = result.passed === null ? "pending" : String(result.passed);
    process.stdout.write(
      `${statusIcon} Suite run ${result.runId}: score=${scoreDisplay} passed=${passedLabel}\n`
    );
  }

  return {
    data: result,
    exitCode,
    message,
  };
}

// ---------------------------------------------------------------------------
// eval list
// ---------------------------------------------------------------------------

export interface EvalRun {
  runId: string;
  suiteId: string;
  suiteName: string | null;
  agentVersion: string;
  overallScore: number | null;
  passed: boolean | null;
  createdAt: string;
}

export interface EvalListResponse {
  data: EvalRun[] | null;
  nextCursor: string | null;
  total: number;
  exitCode: number;
  message: string;
}

/** List recent evaluation suite runs for an agent. */
export async function evalList(
  client: GalaxyHttpClient,
  options: EvalListOptions
): Promise<EvalListResponse> {
  const { agentId, suiteId, limit = DEFAULT_EVAL_LIST_LIMIT, cursor, json } = options;

  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    const msg = `Invalid limit: must be an integer between 1 and 100`;
    if (!json) process.stderr.write(`Error: ${msg}\n`);
    return { data: null, nextCursor: null, total: 0, exitCode: EXIT_ERROR, message: msg };
  }

  const params = new URLSearchParams({ limit: String(limit) });
  if (suiteId) params.set("suite_id", suiteId);
  if (cursor) params.set("cursor", cursor);

  let response: { ok: boolean; status: number; data: unknown };
  try {
    response = await client.request(`/api/v1/agents/${agentId}/eval-runs?${params.toString()}`);
  } catch (error) {
    const msg = `Request failed: ${stringifyError(error)}`;
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { data: null, nextCursor: null, total: 0, exitCode: EXIT_ERROR, message: msg };
  }

  if (!response.ok) {
    const msg = withRequestId(`Request failed with HTTP ${response.status}`, response);
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { data: null, nextCursor: null, total: 0, exitCode: EXIT_ERROR, message: msg };
  }

  const parsed = EvalListApiResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    const msg = `Unexpected response shape: ${parsed.error.message}`;
    if (!json) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return { data: null, nextCursor: null, total: 0, exitCode: EXIT_ERROR, message: msg };
  }

  const nextCursor = parsed.data.next_cursor ?? null;
  const total = parsed.data.total;

  const runs: EvalRun[] = parsed.data.data.map((r) => ({
    runId: r.run_id,
    suiteId: r.suite_id,
    suiteName: r.suite_name ?? null,
    agentVersion: r.agent_version,
    overallScore: r.overall_score,
    passed: r.passed,
    createdAt: r.created_at,
  }));

  if (json) {
    printJson({ data: runs, next_cursor: nextCursor, total });
  } else if (runs.length === 0) {
    process.stdout.write("No evaluation runs found.\n");
  } else {
    const suiteLabels = runs.map((r) => r.suiteName ?? r.suiteId);
    const colWidths = {
      runId: Math.max(MIN_COL_RUN_ID_WIDTH, ...runs.map((r) => r.runId.length)),
      suite: Math.max(MIN_COL_SUITE_WIDTH, ...suiteLabels.map((s) => s.length)),
      version: Math.max(MIN_COL_VERSION_WIDTH, ...runs.map((r) => r.agentVersion.length)),
    };

    const header = [
      "Run ID".padEnd(colWidths.runId),
      "Suite".padEnd(colWidths.suite),
      "Version".padEnd(colWidths.version),
      "Score",
      "Passed",
    ].join("  ");

    process.stdout.write(header + "\n");
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      const suiteLabel = suiteLabels[i]!;
      const statusMark = run.passed === null ? "—  " : run.passed ? "yes" : "no ";
      process.stdout.write(
        [
          run.runId.padEnd(colWidths.runId),
          suiteLabel.padEnd(colWidths.suite),
          run.agentVersion.padEnd(colWidths.version),
          run.overallScore !== null ? run.overallScore.toFixed(3) : "—    ",
          statusMark,
        ].join("  ") + "\n"
      );
    }
    if (nextCursor) {
      process.stdout.write(`\nNext page: --cursor ${nextCursor}\n`);
    }
  }

  return {
    data: runs,
    nextCursor,
    total,
    exitCode: EXIT_PASS,
    message: `${runs.length} run(s) found`,
  };
}
