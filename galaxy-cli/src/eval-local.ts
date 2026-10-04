/**
 * novaos-cli — Local Evaluation Runner
 *
 * Runs evaluation suites against a locally-running agent without
 * requiring platform authentication or a deployed agent.
 *
 * Supports YAML and JSON suite files. YAML requires the `yaml` npm
 * package; if unavailable the runner falls back to JSON-only mode.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { extractA2AResponseText, sendA2AMessage } from "./a2a-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;

/** Every `init` scaffold template listens on `SERVER_PORT`, defaulting to 8001. */
const DEFAULT_AGENT_URL = "http://localhost:8001";
const DEFAULT_THRESHOLD = 0.7;
const EVAL_REQUEST_TIMEOUT_MS = 30_000;

const EXACT_MATCH_SCORE = 1.0;
const PARTIAL_MATCH_SCORE = 0.3;
const NO_EXPECTED_OUTPUT_SCORE = 1.0;
const ZERO_SCORE = 0;
const TONE_PROFESSIONAL_SCORE = 1.0;
const TONE_MIXED_SCORE = 0.5;
const TONE_UNPROFESSIONAL_SCORE = 0.0;
const CITATION_FULL_SCORE = 1.0;
const CITATION_PARTIAL_SCORE = 0.5;
const CITATION_NONE_SCORE = 0.0;
const REFUSAL_DETECTED_SCORE = 1.0;
const REFUSAL_NOT_DETECTED_SCORE = 0.0;

const SUPPORTED_RUBRICS = [
  "exact_match",
  "contains",
  "tone",
  "citation_quality",
  "correctness",
  "safety",
  "refusal_triggered",
  "latency",
] as const;
type SupportedRubric = (typeof SUPPORTED_RUBRICS)[number];

// ---------------------------------------------------------------------------
// Zod schemas for suite files
// ---------------------------------------------------------------------------

const EvalCaseSchema = z.object({
  case_key: z.string().min(1),
  input: z.string().min(1),
  expected_output: z.string().optional(),
  rubrics: z.array(z.enum(SUPPORTED_RUBRICS)).optional(),
});

const EvalSuiteSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(EvalCaseSchema).min(1, "Suite must have at least one test case"),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CaseResult {
  caseKey: string;
  passed: boolean;
  score: number | null;
  skipped?: boolean;
  error?: string;
}

export interface EvalLocalResult {
  suite: string;
  results: CaseResult[];
  avgScore: number;
  allPassed: boolean;
  /** True when every case was skipped (e.g. platform-only rubrics). */
  allSkipped?: boolean;
}

export interface EvalLocalOptions {
  suitePath: string;
  agentUrl?: string;
  output?: string;
  json?: boolean;
  threshold?: number;
}

// ---------------------------------------------------------------------------
// Suite parsing
// ---------------------------------------------------------------------------

async function parseYaml(raw: string): Promise<unknown> {
  const yaml = await import("yaml");
  return yaml.parse(raw);
}

export function parseSuiteFile(path: string, raw: string): EvalSuite {
  let parsed: unknown;
  if (path.endsWith(".json")) {
    parsed = JSON.parse(raw);
  } else if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    // Synchronous parse via dynamic import is not possible; caller must
    // use parseSuiteFileAsync for YAML. This path throws.
    throw new Error("Use parseSuiteFileAsync for YAML files");
  } else {
    throw new Error(`Unsupported suite file extension: ${path}`);
  }

  return EvalSuiteSchema.parse(parsed);
}

export async function parseSuiteFileAsync(path: string, raw: string): Promise<EvalSuite> {
  let parsed: unknown;
  if (path.endsWith(".json")) {
    parsed = JSON.parse(raw);
  } else if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    parsed = await parseYaml(raw);
  } else {
    throw new Error(`Unsupported suite file extension: ${path}`);
  }

  return EvalSuiteSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreResponse(output: unknown, expectedOutput?: string): number {
  if (!expectedOutput) {
    return NO_EXPECTED_OUTPUT_SCORE;
  }

  const outputStr = typeof output === "string" ? output : JSON.stringify(output);

  if (outputStr.includes(expectedOutput)) {
    return EXACT_MATCH_SCORE;
  }

  return PARTIAL_MATCH_SCORE;
}

export function scoreContains(output: unknown, expectedOutput?: string): number {
  if (!expectedOutput) return NO_EXPECTED_OUTPUT_SCORE;
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  return outputStr.toLowerCase().includes(expectedOutput.toLowerCase())
    ? EXACT_MATCH_SCORE
    : ZERO_SCORE;
}

const ALL_CAPS_PATTERN = /\b[A-Z]{4,}\b/;
const EXCESSIVE_PUNCTUATION_PATTERN = /[!?]{3,}/;
const SLANG_PATTERNS = [/\bbruh\b/i, /\blmao\b/i, /\bwtf\b/i, /\bomg\b/i, /\bsmh\b/i];

export function scoreTone(output: unknown): number {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  let issues = 0;
  if (ALL_CAPS_PATTERN.test(outputStr)) issues++;
  if (EXCESSIVE_PUNCTUATION_PATTERN.test(outputStr)) issues++;
  if (SLANG_PATTERNS.some((p) => p.test(outputStr))) issues++;
  if (issues === 0) return TONE_PROFESSIONAL_SCORE;
  if (issues === 1) return TONE_MIXED_SCORE;
  return TONE_UNPROFESSIONAL_SCORE;
}

const URL_PATTERN = /https?:\/\/[^\s)]+/;
const BRACKET_REF_PATTERN = /\[\d+\]/;
const ATTRIBUTION_PATTERNS = [/according to/i, /\bsource:/i, /\breference:/i];

export function scoreCitationQuality(output: unknown): number {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  let signals = 0;
  if (URL_PATTERN.test(outputStr)) signals++;
  if (BRACKET_REF_PATTERN.test(outputStr)) signals++;
  if (ATTRIBUTION_PATTERNS.some((p) => p.test(outputStr))) signals++;
  if (signals >= 2) return CITATION_FULL_SCORE;
  if (signals === 1) return CITATION_PARTIAL_SCORE;
  return CITATION_NONE_SCORE;
}

const REFUSAL_KEYWORDS = [/\bcannot\b/i, /\bI'm sorry\b/i, /\bI can't\b/i, /\bI apologize\b/i];

export function scoreCorrectness(output: unknown, expectedOutput?: string): number {
  return scoreContains(output, expectedOutput);
}

export function scoreSafety(_output: unknown): number | null {
  // Safety is evaluated by the platform engine, not locally.
  return null;
}

export function scoreRefusalTriggered(output: unknown): number {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output);
  return REFUSAL_KEYWORDS.some((p) => p.test(outputStr))
    ? REFUSAL_DETECTED_SCORE
    : REFUSAL_NOT_DETECTED_SCORE;
}

export function scoreLatency(_output: unknown): number | null {
  // Latency is measured at runtime, not from static output.
  return null;
}

const PLATFORM_ONLY_RUBRICS: ReadonlySet<SupportedRubric> = new Set(["safety", "latency"]);

function isCasePlatformOnly(rubrics?: SupportedRubric[]): boolean {
  if (!rubrics || rubrics.length === 0) return false;
  return rubrics.every((r) => PLATFORM_ONLY_RUBRICS.has(r));
}

export function scoreCaseWithRubrics(
  output: unknown,
  expectedOutput?: string,
  rubrics?: SupportedRubric[]
): number | null {
  if (!rubrics || rubrics.length === 0) {
    return scoreResponse(output, expectedOutput);
  }

  const evaluableScores: number[] = [];

  for (const rubric of rubrics) {
    let score: number | null;
    switch (rubric) {
      case "exact_match":
        score = scoreResponse(output, expectedOutput);
        break;
      case "contains":
        score = scoreContains(output, expectedOutput);
        break;
      case "tone":
        score = scoreTone(output);
        break;
      case "citation_quality":
        score = scoreCitationQuality(output);
        break;
      case "correctness":
        score = scoreCorrectness(output, expectedOutput);
        break;
      case "safety":
        score = scoreSafety(output);
        break;
      case "refusal_triggered":
        score = scoreRefusalTriggered(output);
        break;
      case "latency":
        score = scoreLatency(output);
        break;
    }

    if (score === null) {
      process.stderr.write(
        `⚠ Rubric '${rubric}' is not evaluated locally (platform-only). Excluded from score.\n`
      );
    } else {
      evaluableScores.push(score);
    }
  }

  if (evaluableScores.length === 0) {
    return null;
  }

  return evaluableScores.reduce((sum, s) => sum + s, 0) / evaluableScores.length;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function evalLocal(
  options: EvalLocalOptions
): Promise<{ exitCode: number; data?: EvalLocalResult }> {
  const { suitePath, json } = options;
  const agentUrl = options.agentUrl ?? DEFAULT_AGENT_URL;
  const rawThreshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(rawThreshold) || rawThreshold < 0 || rawThreshold > 1) {
    const msg = `Invalid --threshold: must be 0 <= t <= 1 (got ${rawThreshold})`;
    process.stderr.write(`Error: ${msg}\n`);
    return { exitCode: EXIT_ERROR };
  }
  const threshold = rawThreshold;

  let suiteRaw: string;
  try {
    suiteRaw = readFileSync(suitePath, "utf-8");
  } catch (err) {
    process.stderr.write(
      `Failed to read suite file: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { exitCode: EXIT_ERROR };
  }

  let suite: EvalSuite;
  try {
    suite = await parseSuiteFileAsync(suitePath, suiteRaw);
  } catch (err) {
    process.stderr.write(
      `Failed to parse suite file: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { exitCode: EXIT_ERROR };
  }

  process.stderr.write(
    `Running suite "${suite.name}" (${suite.cases.length} cases) against ${agentUrl}\n`
  );

  const results: CaseResult[] = [];

  for (const testCase of suite.cases) {
    if (isCasePlatformOnly(testCase.rubrics)) {
      process.stderr.write(
        `⚠ Case '${testCase.case_key}': no scoreable rubrics available — skipped.\n`
      );
      results.push({
        caseKey: testCase.case_key,
        passed: false,
        score: null,
        skipped: true,
      });
      continue;
    }

    try {
      const result = await sendA2AMessage(agentUrl, testCase.input, {
        timeoutMs: EVAL_REQUEST_TIMEOUT_MS,
      });

      if (result.transportError) {
        results.push({
          caseKey: testCase.case_key,
          passed: false,
          score: ZERO_SCORE,
          error: `HTTP ${result.status}: ${result.transportError}`,
        });
        continue;
      }

      if (result.rpcError) {
        results.push({
          caseKey: testCase.case_key,
          passed: false,
          score: ZERO_SCORE,
          error: `JSON-RPC error ${result.rpcError.code}: ${result.rpcError.message}`,
        });
        continue;
      }

      const output: unknown = extractA2AResponseText(result.body) ?? result.body;
      const score = scoreCaseWithRubrics(output, testCase.expected_output, testCase.rubrics);

      if (score === null) {
        process.stderr.write(
          `⚠ Case '${testCase.case_key}': no scoreable rubrics available — skipped.\n`
        );
        results.push({
          caseKey: testCase.case_key,
          passed: false,
          score: null,
          skipped: true,
        });
        continue;
      }

      results.push({
        caseKey: testCase.case_key,
        passed: score >= threshold,
        score,
      });
    } catch (err) {
      results.push({
        caseKey: testCase.case_key,
        passed: false,
        score: ZERO_SCORE,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const scoredResults = results.filter((r) => !r.skipped && r.score !== null);
  const passedCount = scoredResults.filter((r) => r.passed).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const scoredCount = scoredResults.length;
  const avgScore =
    scoredCount > 0 ? scoredResults.reduce((sum, r) => sum + (r.score ?? 0), 0) / scoredCount : 0;
  const allPassed = scoredCount === 0 ? true : scoredResults.every((r) => r.passed);
  const allSkipped = scoredCount === 0 && results.length > 0;

  const resultData: EvalLocalResult = {
    suite: suite.name,
    results,
    avgScore,
    allPassed,
    ...(allSkipped ? { allSkipped: true } : {}),
  };

  let outputWriteFailed = false;
  if (options.output) {
    try {
      writeFileSync(options.output, JSON.stringify(resultData, null, 2) + "\n", "utf-8");
    } catch (err) {
      outputWriteFailed = true;
      process.stderr.write(
        `Failed to write output file: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  if (allSkipped) {
    process.stderr.write(
      "\n⚠ WARNING: All cases were skipped — no rubrics were evaluated locally.\n" +
        "  CI may report a pass, but this suite produced no scores.\n" +
        "  Use platform eval (`novaos-cli eval run`) or add locally-evaluable rubrics.\n\n"
    );
  }

  if (json) {
    process.stdout.write(JSON.stringify(resultData, null, 2) + "\n");
  } else {
    for (const r of results) {
      if (r.skipped) {
        process.stdout.write(`  \u2298 ${r.caseKey}: skipped (no scoreable rubrics)\n`);
        continue;
      }
      const icon = r.passed ? "\u2713" : "\u2717";
      const errorSuffix = r.error ? ` (${r.error})` : "";
      process.stdout.write(
        `  ${icon} ${r.caseKey}: score=${(r.score ?? 0).toFixed(2)}${errorSuffix}\n`
      );
    }
    const skippedSuffix = skippedCount > 0 ? `, ${skippedCount} skipped` : "";
    process.stdout.write(
      `\n${passedCount}/${scoredCount} passed (avg score: ${avgScore.toFixed(3)}${skippedSuffix})\n`
    );
  }

  if (outputWriteFailed) {
    return { exitCode: EXIT_FAIL, data: resultData };
  }

  return { exitCode: allPassed ? EXIT_PASS : EXIT_FAIL, data: resultData };
}
