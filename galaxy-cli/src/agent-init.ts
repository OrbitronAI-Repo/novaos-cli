/**
 * novaos-cli init — Scaffold a new NovaOS agent project.
 *
 * Template content comes from EMBEDDED_TEMPLATES (a compiled-in snapshot of
 * the per-language agent templates) rather than a filesystem read, so
 * `init` works from a `bun build --compile` standalone binary that has no
 * agent-sdk directory on disk next to it. Writing the scaffolded output
 * still goes through an injectable fs dep (see createAgentInitModule) so
 * tests can substitute an in-memory fake instead of touching real disk.
 * Default exports use production implementations.
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { type NewAgentProtocol, resolveNewAgentProtocol } from "./agent-protocol.js";
import {
  JAVA_AGENT_SDK_ARTIFACT_ID,
  JAVA_AGENT_SDK_GROUP_ID,
  JAVA_AGENT_SDK_VERSION,
  PYTHON_AGENT_SDK_PACKAGE_INDEX_URL,
  PYTHON_AGENT_SDK_PYPI_PACKAGE,
  PYTHON_AGENT_SDK_VERSION,
  TS_AGENT_SDK_NPM_PACKAGE,
  TS_AGENT_SDK_VERSION_RANGE,
} from "./constants.js";
import { EMBEDDED_TEMPLATES } from "./embedded-templates.generated.js";
import { assertNameIsNotPath, assertNoPathTraversal } from "./init-path.js";
import { validateManifest } from "./manifest.js";
import { formatInvalidPublisherError, isValidPublisherSlug } from "./publisher.js";

const SUPPORTED_LANGUAGES = ["typescript", "python", "java"] as const;
export type AgentLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type { NewAgentProtocol as AgentProtocol } from "./agent-protocol.js";

const DEFAULT_VERSION = "0.1.0";
const MANIFEST_SCHEMA_VERSION = "2.0";

export interface AgentInitOptions {
  name: string;
  publisher: string;
  language: AgentLanguage;
  /** Raw --protocol input; validated and normalized via resolveNewAgentProtocol. */
  protocol?: string;
  directory?: string;
  force?: boolean;
}

export interface AgentInitResult {
  directory: string;
  language: AgentLanguage;
  protocol: NewAgentProtocol;
  files: string[];
}

/** The subset of node:fs used by agent scaffolding — swap for an in-memory fake in tests. */
export interface AgentInitFs {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  readdirSync: typeof readdirSync;
}

export interface AgentInitDeps {
  fs?: AgentInitFs;
}

const defaultFs: AgentInitFs = {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
};

function interpolate(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * The deterministic in-cluster service URL for an agent's first release
 * — the same scheme `agent-dns-client.ts` constructs. `buildAgentCard` requires `url` to build a
 * card at all, and nothing downstream ever rewrites a
 * publisher-supplied one, so a freshly-scaffolded agent needs a real,
 * computable address here rather than a placeholder.
 */
function agentServiceUrl(name: string): string {
  return `http://${name}.novaos-execution.svc.cluster.local`;
}

function buildManifest(opts: AgentInitOptions, protocol: NewAgentProtocol): string {
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    name: opts.name,
    version: DEFAULT_VERSION,
    protocol,
    url: agentServiceUrl(opts.name),
    publisher: opts.publisher,
    language: opts.language,
    description: `${opts.name} agent`,
    author: {
      name: opts.publisher,
      email: "developer@example.com",
    },
    tags: [],
    domains: [],
    base_image: "novaos/base-plain:1.0",
    permissions: {
      tools: [],
      max_memory_mb: 512,
      max_cpu_millicores: 1000,
      max_timeout_ms: 300000,
    },
    requiredSecrets: [],
    requiredConfig: [],
    deployment_target: ["chat"],
    skills: [
      {
        name: "greet",
        description: "Greet a user by name",
        // ACP plaintext: Agent.handleAcpRequest passes a string into skill.input.parse
        input_schema: { type: "string" },
        output_schema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      },
    ],
    release_channel: "stable",
    dependencies: {
      skills: {},
      mcp_servers: {},
    },
    rollback_policy: {
      auto_rollback_on_eval_drop: false,
      eval_threshold: 0.8,
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Builds `createAgentInitModule`'s functions against an injectable
 * filesystem dependency — the production module and tests both go through
 * this, just with different `deps`.
 */
export function createAgentInitModule(deps: AgentInitDeps = {}) {
  const fs = deps.fs ?? defaultFs;

  async function agentInit(opts: AgentInitOptions): Promise<AgentInitResult> {
    if (!SUPPORTED_LANGUAGES.includes(opts.language)) {
      throw new Error(
        `Unsupported language "${opts.language}". ` + `Supported: ${SUPPORTED_LANGUAGES.join(", ")}`
      );
    }

    assertNameIsNotPath("agent", opts.name);

    if (!/^[a-z][a-z0-9-]{0,62}$/.test(opts.name)) {
      throw new Error(
        `Invalid agent name "${opts.name}". ` +
          "Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens (max 63 chars)."
      );
    }

    if (!isValidPublisherSlug(opts.publisher)) {
      throw new Error(formatInvalidPublisherError(opts.publisher));
    }

    const protocol = resolveNewAgentProtocol(opts.protocol);

    const rawDir = opts.directory ?? opts.name;
    assertNoPathTraversal(rawDir);
    const targetDir = resolve(rawDir);
    const langTemplates = EMBEDDED_TEMPLATES[opts.language];

    if (!langTemplates) {
      throw new Error(`No embedded templates found for language "${opts.language}"`);
    }

    if (fs.existsSync(targetDir) && !opts.force) {
      const entries = fs.readdirSync(targetDir);
      if (entries.length > 0) {
        throw new Error(
          `Directory "${targetDir}" already exists and is not empty. ` + "Use --force to overwrite."
        );
      }
    }

    const templateVars: Record<string, string> = {
      agent_name: opts.name,
      version: DEFAULT_VERSION,
      description: `${opts.name} agent`,
      publisher: opts.publisher,
      author_name: opts.publisher,
      author_email: "developer@example.com",
      python_sdk_package: PYTHON_AGENT_SDK_PYPI_PACKAGE,
      python_sdk_version: PYTHON_AGENT_SDK_VERSION,
      python_sdk_index_url: PYTHON_AGENT_SDK_PACKAGE_INDEX_URL,
      ts_sdk_package: TS_AGENT_SDK_NPM_PACKAGE,
      ts_sdk_version_range: TS_AGENT_SDK_VERSION_RANGE,
      java_sdk_group_id: JAVA_AGENT_SDK_GROUP_ID,
      java_sdk_artifact_id: JAVA_AGENT_SDK_ARTIFACT_ID,
      java_sdk_version: JAVA_AGENT_SDK_VERSION,
    };

    const writtenFiles: string[] = [];

    for (const [relPath, raw] of Object.entries(langTemplates)) {
      if (relPath === "manifest.json") continue;

      const destPath = join(targetDir, relPath);

      fs.mkdirSync(dirname(destPath), { recursive: true });

      const interpolated = interpolate(raw, templateVars);
      fs.writeFileSync(destPath, interpolated, "utf-8");
      writtenFiles.push(relPath);
    }

    const manifestContent = buildManifest(opts, protocol);
    const manifestPath = join(targetDir, "manifest.json");
    fs.mkdirSync(dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, manifestContent, "utf-8");
    const validationResult = validateManifest(JSON.parse(manifestContent));
    if (!validationResult.valid) {
      const errs =
        validationResult.errors?.map((e) => `  ${e.path}: ${e.message}`).join("\n") ?? "";
      throw new Error(`Generated manifest is invalid (template bug):\n${errs}`);
    }
    writtenFiles.push("manifest.json");

    const sandboxEnvContent = [
      "NOVAOS_ENV=sandbox",
      "MCP_GATEWAY_URL=http://localhost:4000",
      "LLM_GATEWAY_URL=http://localhost:4001/v1",
      "MEMORY_SERVICE_URL=http://localhost:4002",
      "DATABASE_URL=postgresql://sandbox:sandbox@localhost:5433/novaos_sandbox",
      "",
    ].join("\n");
    fs.writeFileSync(join(targetDir, "sandbox.env"), sandboxEnvContent, "utf-8");
    writtenFiles.push("sandbox.env");

    const sandboxToolsContent =
      JSON.stringify(
        {
          "novaos.knowledge.search": {
            content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
          },
        },
        null,
        2
      ) + "\n";
    fs.writeFileSync(join(targetDir, "sandbox-tools.json"), sandboxToolsContent, "utf-8");
    writtenFiles.push("sandbox-tools.json");

    return {
      directory: targetDir,
      language: opts.language,
      protocol,
      files: writtenFiles.sort(),
    };
  }

  return { agentInit };
}

// ---- Backward-Compatible Exports ----

const defaultModule = createAgentInitModule();
export const { agentInit } = defaultModule;
