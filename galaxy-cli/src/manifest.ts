/**
 * Agent Manifest v2 — Validation and v1 Auto-Upgrade
 *
 * v2 is a strict superset of v1. All new fields are optional.
 * Existing v1 manifests are valid v2 manifests after auto-upgrade.
 */

import { isRestAdapter, isSdkAdapter } from "@novaos-cli/shared/adapter-type";
import { z } from "zod";

import { MANIFEST_PROTOCOL_VALUES } from "./agent-protocol.js";
import {
  APPROVED_BASE_IMAGES,
  PLATFORM_MAX_MEMORY_MB,
  PLATFORM_MAX_CPU_MILLICORES,
} from "./constants.js";
import { BRIDGE_REFUSAL_MESSAGES, checkProgressBridge } from "./progress-bridge.js";

// ---- Zod Schema (runtime validation) ----

// Flat capability tags — matches the granularity of every other entry here
// (e.g. "llm", "knowledge"). "connectors" declares that the agent uses the
// client SDK's governed ConnectorTool (novaos_client_sdk/tools.py) to reach
// third-party integrations (ClickUp, Slack, Gmail, ...) through connector-host.
// *Which* connector(s) an agent may reach is NOT decided here — that stays
// scope-based, enforced by connector-host at runtime off the execution
// token's JWT scopes (connector:invoke + a per-connector/operation scope).
// This value is purely declarative, for review and the security scanner.
// A future `permissions.connectors: string[]` naming specific connector
// ids/slugs (alongside requiredSecrets/requiredConfig) would let reviewers
// see *which* connectors an agent declares — deliberately out of scope here.
//
// Exported so consumers that classify or mirror these values — the security
// scanner's permission-analyzer.ts, and manifest-schema-v2.json's own copy of
// this same enum for the published JSON-Schema artifact — can be tested for
// parity against this list instead of re-declaring it and drifting
// (tests/manifest-permissions-parity.test.ts).
export const PERMISSION_TOOL_VALUES = [
  "memory",
  "knowledge",
  "llm",
  "hitl",
  "files",
  "notify",
  "http",
  "browser",
  "code",
  "agents",
  "connectors",
] as const;

// Tool categories that can change state outside the run. An agent granted any
// of them should declare `resumable: true`, meaning it saves and resumes through
// the SDK save-and-resume interface, so a retried or resumed task does not
// repeat a write. Publish warns when the declaration is missing; it does not block.
export const WRITE_PERMISSION_TOOLS: ReadonlySet<(typeof PERMISSION_TOOL_VALUES)[number]> = new Set(
  ["memory", "files", "notify", "http", "browser", "code", "agents", "connectors"]
);

const PermissionsSchema = z
  .object({
    tools: z.array(z.enum(PERMISSION_TOOL_VALUES)).optional(),
    network_egress: z.array(z.string()).optional(),
    max_memory_mb: z.number().int().min(64).max(8192).optional(),
    max_cpu_millicores: z.number().int().min(100).max(4000).optional(),
    max_timeout_ms: z.number().int().min(1000).max(600000).optional(),
  })
  .optional();

const SkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
  output_schema: z.record(z.unknown()).optional(),
});

const ShadowEvaluationSchema = z
  .object({
    correctness_mode: z
      .enum(["exact_match", "semantic_similarity", "llm_judge"])
      .default("semantic_similarity"),
    correctness_threshold: z.number().min(0).max(1).default(0.85),
    latency_threshold_p95_ms: z.number().int().default(5000),
    cost_increase_threshold_pct: z.number().int().default(20),
    min_sample_size: z.number().int().min(10).default(100),
  })
  .optional();

const ShadowSchema = z
  .object({
    evaluation: ShadowEvaluationSchema,
  })
  .optional();

/**
 * The in-run check an agent declares: which judge, which rubrics and what bar. A rubric is a
 * built-in (`builtin`) or a published one pinned to a version (`ref`). `file` is accepted by the
 * shape only so it can be refused with a reason: custom rubric files are not available yet.
 * Unknown settings are errors, so a misspelt setting cannot be silently dropped.
 */
export const CUSTOM_RUBRIC_FILE_UNAVAILABLE =
  "custom rubric files are not available yet; use a built-in or a published rubric reference";

const InRunCheckRubricSchema = z
  .object({
    builtin: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    ref: z
      .string()
      .regex(/^[a-z0-9_-]+\/[a-z0-9_]+@[1-9][0-9]*$/, "must be publisher/name@version")
      .optional(),
    file: z.string().min(1).optional(),
    threshold: z.number().min(0).optional(),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    if (rubric.file !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: CUSTOM_RUBRIC_FILE_UNAVAILABLE,
      });
      return;
    }
    const named = [rubric.builtin, rubric.ref].filter((v) => v !== undefined).length;
    if (named !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a rubric names exactly one of builtin or ref",
      });
    }
  });

const InRunCheckSchema = z
  .object({
    judge_model: z.string().min(1),
    threshold: z.number().min(0).optional(),
    max_refinements: z.number().int().min(0).optional(),
    budget_ms: z.number().int().positive().optional(),
    deterministic: z.array(z.string().min(1)).optional(),
    regulated_outputs: z.array(z.string().min(1)).optional(),
    rubrics: z.array(InRunCheckRubricSchema).min(1),
  })
  .strict()
  .optional();

const AuthorSchema = z
  .object({
    name: z.string(),
    email: z.string().email().optional(),
  })
  .optional();

/** v1 metadata block (deprecated, auto-upgraded to top-level fields) */
const V1MetadataSchema = z
  .object({
    capabilities: z.array(z.unknown()).optional(),
    domains: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    author: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
  })
  .optional();

const PUBLISHER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const BASE_IMAGE_PATTERN = /^novaos\/base-(langgraph|crewai|plain):\d+\.\d+$/;

const ModelsSchema = z
  .object({
    required: z.array(z.string()).optional(),
    optional: z.array(z.string()).optional(),
  })
  .optional();

// ---- Installation Config (optional rich form for the marketplace install UI) ----
// The short form (top-level `requiredSecrets`/`requiredConfig` string arrays) stays
// the zero-friction path for authors. When an author needs labels, help text, or
// typed config fields for the marketplace install dialog, they can declare this
// block explicitly. During publish, agent-ops fills in anything the author left
// unset from the short-form arrays.
//
// All fields are optional and `.passthrough()` keeps the schema
// forward-compatible with future additions.

const RequiredSecretSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().optional(),
    description: z.string().optional(),
    type: z.enum(["string", "password", "url", "number"]).default("password"),
    validation: z
      .object({
        pattern: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ConfigPropertySchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "select"]),
    label: z.string().optional(),
    description: z.string().optional(),
    default: z.unknown().optional(),
    validation: z
      .object({
        pattern: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .passthrough()
      .optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const ConfigSchemaSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(ConfigPropertySchema),
    required: z.array(z.string()).optional(),
  })
  .passthrough();

const DefaultPolicySchema = z
  .object({
    timeout_ms: z.number().nonnegative().optional(),
    max_retries: z.number().int().nonnegative().optional(),
    rate_limit: z
      .object({
        requests_per_second: z.number().nonnegative().optional(),
        requests_per_minute: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    concurrency_limit: z.number().int().nonnegative().optional(),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
  })
  .passthrough();

const InstallationResourcesSchema = z
  .object({
    memory_mb: z.number().int().nonnegative().optional(),
    cpu_cores: z.number().nonnegative().optional(),
    storage_mb: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const InstallationConfigSchema = z
  .object({
    required_secrets: z.array(RequiredSecretSchema).optional(),
    config_schema: ConfigSchemaSchema.optional(),
    default_config: z.record(z.unknown()).optional(),
    optional_config: z.record(ConfigPropertySchema).optional(),
    default_policy: DefaultPolicySchema.optional(),
    resources: InstallationResourcesSchema.optional(),
    installation_notes: z.string().optional(),
    min_marketplace_version: z.string().optional(),
  })
  .passthrough();

export type InstallationConfig = z.infer<typeof InstallationConfigSchema>;

export const AgentManifestV2Schema = z.object({
  // Core (inherited from v1)
  schema_version: z.enum(["1.0", "2.0"]).default("2.0"),
  sdk_version: z.string().optional(),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  version: z.string().optional(),
  // Adapter selector, not a wire protocol — "A2A" is the canonical name for
  // the SDK adapter. ACP is not supported going forward — "ACP" is accepted
  // here only as a permanent legacy-parse
  // tolerance for manifests written before this change, never as new input;
  // see agent-protocol.ts, the single source of truth for this, which
  // rejects it outright for new agent scaffolding (`novaos-cli init --protocol ACP`).
  protocol: z
    .enum(MANIFEST_PROTOCOL_VALUES)
    .describe(
      'Adapter selector, not a wire protocol. "A2A" is the canonical name for the SDK adapter; ' +
        '"ACP" parses only as a legacy value in manifests predating the A2A-only change.'
    ),
  url: z.string().url().optional(),

  // v1 metadata (deprecated, auto-upgraded)
  metadata: V1MetadataSchema,

  // v2 publisher identity (NEW, required)
  publisher: z
    .string()
    .regex(
      PUBLISHER_PATTERN,
      "Publisher must be a DNS-compatible slug (lowercase, start with letter, alphanumeric + hyphens, max 63 chars)"
    ),

  // v2 base image (NEW, required)
  base_image: z
    .string()
    .regex(BASE_IMAGE_PATTERN, "base_image must match novaos/base-(langgraph|crewai|plain):X.Y"),

  // v2 model requirements (NEW, optional)
  models: ModelsSchema,

  // v2 top-level fields (NEW)
  language: z.enum(["python", "java", "typescript"]).optional(),
  description: z.string().max(500).optional(),
  author: AuthorSchema,
  tags: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),

  // v2 permissions (NEW)
  permissions: PermissionsSchema,

  // Declares that the agent saves and resumes through the SDK save-and-resume
  // interface. Expected whenever permissions.tools grants a write tool.
  resumable: z.boolean().optional(),

  // The in-run check the agent runs on its own output, declared once and resolved by the
  // platform at publish.
  in_run_check: InRunCheckSchema,

  // How the platform drives an agent that starts a job with one skill and polls it with
  // another. Kept as written so it reaches the server; the whole block is checked by
  // `checkProgressBridge` in validateManifest (see progress-bridge.ts).
  progress_bridge: z.unknown().optional(),

  // Inherited (short form — quick author ergonomics)
  requiredSecrets: z.array(z.string()).optional(),
  requiredConfig: z.array(z.string()).optional(),

  // v2 rich install contract (NEW, optional)
  // Authors who want labels/help/types in the marketplace install dialog can
  // declare this directly. Otherwise agent-ops synthesizes it from the short
  // form above during publish (see packages/agent-ops/src/services/
  // installation-config-synth.ts).
  installation_config: InstallationConfigSchema.optional(),

  // v2 skills (NEW)
  skills: z.array(SkillSchema).optional(),

  // Agent Card runtime capture. `MODULE:ATTR` naming the
  // AgentBuilder instance `novaos-cli publish` runs the SDK emitter
  // against — resolved the same way uvicorn/gunicorn resolve their target.
  // Defaults to "server:agent", matching the Python scaffold template, so
  // most agents never need to set this explicitly.
  agent_module: z.string().optional(),

  // v2 shadow testing (NEW)
  shadow: ShadowSchema,

  // v2 deployment target (NEW) — controls marketplace visibility and installability
  deployment_target: z
    .array(z.enum(["chat", "api"]))
    .min(1, "deployment_target must contain at least one value")
    .optional(),
});

export type AgentManifestV2 = z.infer<typeof AgentManifestV2Schema>;
export type AgentModels = z.infer<typeof ModelsSchema>;

// ---- v1 -> v2 Auto-Upgrade ----

/**
 * Upgrade a v1 manifest to v2 format.
 * - Promotes metadata.tags, metadata.domains, metadata.author to top level
 * - Sets schema_version to "2.0"
 * - Preserves all existing fields
 * - All new v2 fields remain optional (not added if absent)
 */
const DEFAULT_PUBLISHER = "novaos";
const DEFAULT_BASE_IMAGE = "novaos/base-plain:1.0";

export function upgradeV1toV2(manifest: Record<string, unknown>): Record<string, unknown> {
  const upgraded = { ...manifest };

  upgraded.schema_version = "2.0";

  // Map v1 adapter_type to v2 protocol
  if (!upgraded.protocol && upgraded.adapter_type) {
    const rawAdapterType = upgraded.adapter_type as string;
    if (isSdkAdapter(rawAdapterType)) {
      upgraded.protocol = "A2A";
    } else if (isRestAdapter(rawAdapterType)) {
      upgraded.protocol = "REST";
    }
    delete upgraded.adapter_type;
  }

  // Promote metadata fields to top level (if not already set)
  const metadata = manifest.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    if (!upgraded.tags && metadata.tags) {
      upgraded.tags = metadata.tags;
    }
    if (!upgraded.domains && metadata.domains) {
      upgraded.domains = metadata.domains;
    }
    if (!upgraded.author && metadata.author) {
      upgraded.author = metadata.author;
    }
  }

  // Provide defaults for v2 required fields absent in v1 manifests
  if (!upgraded.publisher) {
    upgraded.publisher = DEFAULT_PUBLISHER;
  }
  if (!upgraded.base_image) {
    upgraded.base_image = DEFAULT_BASE_IMAGE;
  }

  return upgraded;
}

// ---- Validation ----

/**
 * Warning for an agent that is granted write tools but does not declare
 * `resumable: true`, or undefined when there is nothing to warn about.
 */
export function resumableWriteWarning(manifest: AgentManifestV2): string | undefined {
  if (manifest.resumable === true) return undefined;
  const writeTools = (manifest.permissions?.tools ?? []).filter((t) =>
    WRITE_PERMISSION_TOOLS.has(t)
  );
  if (writeTools.length === 0) return undefined;
  return (
    `permissions.tools grants write tools (${writeTools.join(", ")}) but the manifest does not set ` +
    `"resumable": true. A retried or resumed task may repeat its writes. Use the SDK ` +
    `save-and-resume interface and set "resumable": true.`
  );
}

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: AgentManifestV2;
  errors?: Array<{ path: string; message: string }>;
  warnings?: string[];
  upgraded: boolean;
}

/**
 * Validate an agent manifest. Auto-upgrades v1 manifests to v2 before validation.
 */
export function validateManifest(
  raw: unknown,
  options: { now?: Date } = {}
): ManifestValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return {
      valid: false,
      errors: [{ path: "", message: "Manifest must be a JSON object" }],
      upgraded: false,
    };
  }

  let manifest = raw as Record<string, unknown>;
  let upgraded = false;

  // Auto-upgrade v1 (any version that isn't 2.0)
  const schemaVersion = manifest.schema_version as string | undefined;
  if (!schemaVersion || schemaVersion !== "2.0") {
    manifest = upgradeV1toV2(manifest);
    upgraded = true;
  }

  // Validate against v2 schema
  const result = AgentManifestV2Schema.safeParse(manifest);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      upgraded,
    };
  }

  const bridgeRefusals = checkProgressBridge(manifest, options.now ?? new Date());
  if (bridgeRefusals.length > 0) {
    return {
      valid: false,
      errors: bridgeRefusals.map((r) => ({
        path: r.path,
        message: BRIDGE_REFUSAL_MESSAGES[r.code],
      })),
      upgraded,
    };
  }

  const warnings: string[] = [];

  if (result.data.base_image) {
    const imageBase = result.data.base_image.replace(/:.*$/, "");
    if (!APPROVED_BASE_IMAGES.some((approved) => imageBase.startsWith(approved))) {
      warnings.push(
        `base_image "${result.data.base_image}" is not in the platform-approved list. ` +
          `Approved prefixes: ${APPROVED_BASE_IMAGES.join(", ")}`
      );
    }
  }

  if (result.data.deployment_target) {
    const targets = result.data.deployment_target;
    if (!targets.includes("chat")) {
      warnings.push(
        `deployment_target is ["${targets.join('", "')}"]. This agent will NOT appear in marketplace ` +
          `browse listings and cannot be installed by non-admin users. Only platform administrators ` +
          `can provision it for service accounts.`
      );
    }
  }

  const resumableWarning = resumableWriteWarning(result.data);
  if (resumableWarning) warnings.push(resumableWarning);

  const perms = result.data.permissions;
  if (perms?.max_memory_mb && perms.max_memory_mb > PLATFORM_MAX_MEMORY_MB) {
    return {
      valid: false,
      errors: [
        {
          path: "permissions.max_memory_mb",
          message: `Exceeds platform maximum (${PLATFORM_MAX_MEMORY_MB} MB). Requested: ${perms.max_memory_mb} MB`,
        },
      ],
      upgraded,
    };
  }
  if (perms?.max_cpu_millicores && perms.max_cpu_millicores > PLATFORM_MAX_CPU_MILLICORES) {
    return {
      valid: false,
      errors: [
        {
          path: "permissions.max_cpu_millicores",
          message: `Exceeds platform maximum (${PLATFORM_MAX_CPU_MILLICORES}m). Requested: ${perms.max_cpu_millicores}m`,
        },
      ],
      upgraded,
    };
  }

  return {
    valid: true,
    manifest: result.data,
    warnings: warnings.length > 0 ? warnings : undefined,
    upgraded,
  };
}
