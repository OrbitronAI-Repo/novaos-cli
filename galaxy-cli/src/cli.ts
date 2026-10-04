#!/usr/bin/env bun
/**
 * novaos-cli Entry Point
 *
 * Maps CLI commands to library functions via Commander.
 * Three HTTP clients target three backend services:
 *   - AgentOps  (release commands)
 *   - MCPOps    (mcp publish)
 *   - Gateway   (eval commands)
 */

import { readFileSync } from "node:fs";

import { stringifyError } from "@novaos-cli/shared/utils";
import { Command } from "commander";

import pkg from "../package.json";

import { agentInit, type AgentLanguage } from "./agent-init.js";
import { agentLogs, agentPodLogs } from "./agent-logs.js";
import {
  getAccessToken,
  login,
  logout,
  whoami,
  requireDeveloperRole,
  requirePlatformAdmin,
  listOrganizations,
  useOrganization,
  showOrganization,
} from "./auth.js";
import {
  buildCompletionSpec,
  buildGlobalOptionsSpec,
  generateCompletionScript,
  isSupportedShell,
  SUPPORTED_SHELLS,
} from "./completion.js";
import {
  getActiveEnvironment,
  setActiveEnvironment,
  resolveActiveEnvironment,
  resolveUrls,
  resolveUrlsWithProvenance,
  resolveRetryConfig,
  upsertEnvironmentConfigEntry,
  type EnvironmentSource,
  type ResolvedField,
} from "./config.js";
import { connectorList, connectorInit, connectorPublish, connectorRegister } from "./connector.js";
import { RETRY_MODES } from "./constants.js";
import { debugTrace, debugWatch, debugCompare, debugBreakpoint } from "./debug.js";
import {
  type EnvironmentConfigEntry,
  type EnvironmentName,
  type EnvironmentUrls,
  type ServiceEnvironmentTier,
  isValidEnvironment,
  getEnvironment,
  getEnvironmentConfigPath,
  getEnvironmentNames,
  getEnvironments,
  cliEnvToServiceEnvironment,
  describeUnknownEnvironment,
} from "./environments.js";
import { evalLocal } from "./eval-local.js";
import { evalRun, evalList } from "./eval.js";
import { heartbeatList, heartbeatStatus, heartbeatCreate } from "./heartbeat.js";
import { type GalaxyHttpClient, createGalaxyHttpClient } from "./http-client.js";
import { validateManifest } from "./manifest.js";
import { mcpInit } from "./mcp-init.js";
import { mcpLogs } from "./mcp-logs.js";
import { validateMcpManifest, mcpPublish } from "./mcp-manifest.js";
import { mcpPodLogs } from "./mcp-pod-logs.js";
import { migrateManifest } from "./migrate.js";
import { publishStatus } from "./publish-status.js";
import { agentPublish } from "./publish.js";
import {
  createMarketplaceClientForEnv,
  fetchPublisherLookup,
  formatPublisherShowNoneMessage,
  resolvePublisherSlugForInit,
} from "./publisher.js";
import { isPreCutoverIndex, PYTHON_SDK_PRE_CUTOVER_WARNING } from "./python-sdk-release.js";
import { releaseCreate, releasePromote, releaseRollback, releaseList } from "./release.js";
import { sandboxStart, sandboxStop, sandboxStatus } from "./sandbox.js";
import {
  shadowDeploy,
  shadowPromote,
  shadowRollback,
  shadowReplay,
  shadowSummary,
  type ShadowEvaluationConfig,
} from "./shadow.js";
import { skillList, skillCall } from "./skill.js";

// Statically imported (not read at runtime via fs) so the version survives
// `bun build --compile`: a compiled binary's virtual filesystem doesn't
// contain package.json, only files the bundler can see at build time.
const CLI_VERSION: string = pkg.version;

const program = new Command();

program
  .name("novaos-cli")
  .description("NovaOS CLI — Agent Development Lifecycle tooling for NovaOS")
  .version(CLI_VERSION, "-V, --cli-version");

// ---------------------------------------------------------------------------
// Global options
// ---------------------------------------------------------------------------

program
  .option("--env <name>", `Target environment (${getEnvironmentNames().join(", ")})`)
  .option("--agent-ops-url <url>", "Override AgentOps service URL")
  .option("--mcp-ops-url <url>", "Override MCPOps service URL")
  .option("--review-url <url>", "Override Review service URL")
  .option("--gateway-url <url>", "Override Execution Gateway URL")
  .option("--iam-url <url>", "Override IAM (Logto) URL")
  .option(
    "--connector-host-url <url>",
    "Override Connector Registry (connector-host) admin API URL"
  )
  .option("--client-id <id>", "Override OAuth client ID")
  .option("--retry-mode <mode>", `HTTP retry mode (${RETRY_MODES.join(", ")})`)
  .option("--max-attempts <n>", "Max HTTP request attempts (including the first)")
  .option(
    "--debug",
    "Print wire-level HTTP request/response detail to stderr (redacts bearer/ID tokens)"
  );

let resolvedUrls: Awaited<ReturnType<typeof resolveUrls>> | null = null;
let resolvedEnvName: EnvironmentName | null = null;
let resolvedRetryConfig: Awaited<ReturnType<typeof resolveRetryConfig>> | null = null;

async function getResolvedUrls() {
  if (resolvedUrls) return resolvedUrls;
  const opts = program.opts();
  const resolved = await resolveActiveEnvironment(opts.env);
  resolvedEnvName = resolved.name;
  resolvedUrls = resolveUrls(resolved.name);
  return resolvedUrls;
}

/** Returns the resolved environment name (populates cache via getResolvedUrls if needed). */
async function getResolvedEnvName(): Promise<EnvironmentName> {
  await getResolvedUrls();
  return resolvedEnvName!;
}

/** Resolves --retry-mode/--max-attempts (falls back to env var/config file/default). */
async function getResolvedRetryConfig() {
  if (resolvedRetryConfig) return resolvedRetryConfig;
  const opts = program.opts();
  const maxAttempts =
    opts.maxAttempts !== undefined ? Number.parseInt(opts.maxAttempts, 10) : undefined;
  resolvedRetryConfig = await resolveRetryConfig({ mode: opts.retryMode, maxAttempts });
  return resolvedRetryConfig;
}

async function getAgentOpsClient(): Promise<GalaxyHttpClient> {
  const opts = program.opts();
  const url = opts.agentOpsUrl || (await getResolvedUrls()).agentOpsUrl;
  return createGalaxyHttpClient(url, {
    retry: await getResolvedRetryConfig(),
    debug: opts.debug ?? false,
  });
}

async function getMcpOpsClient(): Promise<GalaxyHttpClient> {
  const opts = program.opts();
  const url = opts.mcpOpsUrl || (await getResolvedUrls()).mcpOpsUrl;
  return createGalaxyHttpClient(url, {
    retry: await getResolvedRetryConfig(),
    debug: opts.debug ?? false,
  });
}

async function getGatewayClient(): Promise<GalaxyHttpClient> {
  const opts = program.opts();
  const url = opts.gatewayUrl || (await getResolvedUrls()).gatewayUrl;
  return createGalaxyHttpClient(url, {
    retry: await getResolvedRetryConfig(),
    debug: opts.debug ?? false,
  });
}

async function getConnectorHostClient(): Promise<GalaxyHttpClient> {
  const opts = program.opts();
  const url = opts.connectorHostUrl || (await getResolvedUrls()).connectorHostUrl;
  return createGalaxyHttpClient(url, {
    retry: await getResolvedRetryConfig(),
    debug: opts.debug ?? false,
  });
}

// ---------------------------------------------------------------------------
// version (explicit subcommand)
// ---------------------------------------------------------------------------

program
  .command("version")
  .description("Print CLI version")
  .action(() => {
    process.stdout.write(`novaos-cli ${CLI_VERSION}\n`);
  });

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

program
  .command("completion")
  .description("Generate a shell completion script")
  .argument("<shell>", `Shell to generate a completion script for (${SUPPORTED_SHELLS.join(", ")})`)
  .action((shell: string) => {
    if (!isSupportedShell(shell)) {
      process.stderr.write(`Unknown shell "${shell}". Valid: ${SUPPORTED_SHELLS.join(", ")}\n`);
      process.exit(1);
    }
    const script = generateCompletionScript(
      "novaos-cli",
      buildCompletionSpec(program),
      buildGlobalOptionsSpec(program)
    );
    process.stdout.write(script);
  });

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

const auth = program.command("auth").description("Authentication commands");

// login is the only auth subcommand that otherwise resolves --env; validate
// it here too so an unknown/mistyped name fails the same way across the
// whole group instead of being silently ignored by logout/whoami/token/org.
auth.hook("preAction", () => {
  const envFlag = program.opts().env;
  if (envFlag && !isValidEnvironment(envFlag)) {
    process.stderr.write(`Error: ${describeUnknownEnvironment(envFlag)}\n`);
    process.exit(1);
  }
});

auth
  .command("login")
  .description("Authenticate with NovaOS ID via browser login")
  .action(async () => {
    try {
      const urls = await getResolvedUrls();
      const opts = program.opts();
      await login({
        iamUrl: opts.iamUrl || urls.iamUrl,
        clientId: opts.clientId || urls.clientId,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

auth
  .command("logout")
  .description("Clear stored credentials")
  .action(async () => {
    try {
      await logout();
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

auth
  .command("whoami")
  .description(
    "Show current authenticated identity (includes Marketplace publisher_slug when resolvable)"
  )
  .action(async () => {
    try {
      const identity = await whoami();
      let publisher_slug: string | null = identity.publisher_name ?? null;
      let publisher_membership: "jwt" | "found" | "none" | "unavailable" = identity.publisher_name
        ? "jwt"
        : "unavailable";

      if (!publisher_slug) {
        try {
          const { client } = createMarketplaceClientForEnv(
            await getResolvedEnvName(),
            program.opts().debug ?? false
          );
          const lookup = await fetchPublisherLookup(client);
          if (lookup.status === "found") {
            publisher_slug = lookup.publisher.name;
            publisher_membership = "found";
          } else if (lookup.status === "none") {
            publisher_membership = "none";
          }
        } catch {
          publisher_membership = "unavailable";
        }
      }

      process.stdout.write(
        JSON.stringify({ ...identity, publisher_slug, publisher_membership }, null, 2) + "\n"
      );
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

auth
  .command("token")
  .description("Print the current access token to stdout (refreshes if expired)")
  .action(async () => {
    try {
      const token = await getAccessToken();
      process.stdout.write(`${token}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

const authOrg = auth.command("org").description("Active organization (API tenant context)");

authOrg
  .command("list")
  .description("List Logto organizations for the logged-in user")
  .action(async () => {
    try {
      const result = await listOrganizations();
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

authOrg
  .command("use")
  .description("Set the active organization and refresh an org-scoped access token")
  .argument("<organizationId>", "Logto organization ID")
  .action(async (organizationId: string) => {
    try {
      const identity = await useOrganization(organizationId);
      process.stdout.write(
        JSON.stringify(
          {
            activeOrganizationId: identity.organization_id,
            tenant_id: identity.tenant_id,
            subject: identity.subject,
            email: identity.email,
          },
          null,
          2
        ) + "\n"
      );
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

authOrg
  .command("show")
  .description("Show active organization and tenant claims from the current access token")
  .action(async () => {
    try {
      const result = await showOrganization();
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// publisher
// ---------------------------------------------------------------------------

const publisherCmd = program
  .command("publisher")
  .description("Publisher profile discovery (Marketplace membership)");

publisherCmd
  .command("show")
  .description("Show publisher slug for the authenticated developer (respects global --env)")
  .option("--json", "Emit machine-readable JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      const { client, env } = createMarketplaceClientForEnv(
        await getResolvedEnvName(),
        program.opts().debug ?? false
      );
      const lookup = await fetchPublisherLookup(client);

      if (lookup.status === "error") {
        process.stderr.write(`Error: ${lookup.message}\n`);
        process.exit(1);
      }

      if (lookup.status === "none") {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ environment: env, publisher: null, membership: "none" }, null, 2) +
              "\n"
          );
        } else {
          process.stderr.write(formatPublisherShowNoneMessage(env));
        }
        process.exit(1);
      }

      const payload = {
        environment: env,
        publisher_slug: lookup.publisher.name,
        publisher_id: lookup.publisher.id,
        display_name: lookup.publisher.display_name ?? null,
        status: lookup.publisher.status ?? null,
        membership: "found" as const,
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      } else {
        process.stdout.write(`Environment: ${payload.environment}\n`);
        process.stdout.write(`Publisher slug: ${payload.publisher_slug}\n`);
        if (payload.display_name) {
          process.stdout.write(`Display name: ${payload.display_name}\n`);
        }
        if (payload.status) {
          process.stdout.write(`Status: ${payload.status}\n`);
        }
        process.stdout.write(
          `\nUse with init: novaos-cli init --name <agent> --publisher ${payload.publisher_slug}\n`
        );
      }
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const env = program.command("env").description("Environment management");

env
  .command("use")
  .description("Set the active target environment")
  .argument("<name>", `Environment name (${getEnvironmentNames().join(", ")})`)
  .action(async (name: string) => {
    try {
      if (!isValidEnvironment(name)) {
        process.stderr.write(`${describeUnknownEnvironment(name)}\n`);
        process.exit(1);
      }
      await setActiveEnvironment(name);
      const preset = getEnvironment(name);
      process.stdout.write(`Active environment: ${preset.name} (${preset.label})\n`);
      process.stdout.write(`  Agent Ops: ${preset.agentOpsUrl}\n`);
      process.stdout.write(`  MCP Ops:   ${preset.mcpOpsUrl}\n`);
      process.stdout.write(`  Review:    ${preset.reviewUrl}\n`);
      process.stdout.write(`  Gateway:   ${preset.gatewayUrl}\n`);
      process.stdout.write(`  IAM:       ${preset.iamUrl}\n`);
      process.stdout.write(`  Connector: ${preset.connectorHostUrl}\n`);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

env
  .command("list")
  .description("List available environments")
  .action(async () => {
    try {
      const active = await getActiveEnvironment();
      for (const preset of Object.values(getEnvironments())) {
        const marker = preset.name === active ? " *" : "";
        process.stdout.write(`  ${preset.name}${marker}  ${preset.label}  ${preset.apiBase}\n`);
      }
      process.stdout.write(`\n  * = active\n`);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

const SERVICE_ENVIRONMENT_TIERS: readonly ServiceEnvironmentTier[] = [
  "dev",
  "staging",
  "production",
];

env
  .command("add")
  .description("Add or replace a named environment in the environments config file")
  .argument("<name>", 'Environment name (not "local" — that one is built in)')
  .option("--api-base <url>", "Base URL; agent-ops/mcp-ops/review/gateway/iam paths derive from it")
  .option("--marketplace-url <url>", "Marketplace admin API URL (optional)")
  .option("--label <label>", "Display label (defaults to the environment name)")
  .option(
    "--service-environment <tier>",
    `Service-registry tier (${SERVICE_ENVIRONMENT_TIERS.join(", ")}); inferred from the name when omitted`
  )
  .addHelpText(
    "after",
    "\nAgent Ops/MCP Ops/Review/Gateway/IAM/Connector Host URLs and the client ID are the same " +
      "global --agent-ops-url/--mcp-ops-url/--review-url/--gateway-url/--iam-url/--connector-host-url/--client-id " +
      "flags env show uses to override a session — pass them here to persist them into this " +
      "environment's entry instead. --client-id is required; the rest fall back to --api-base."
  )
  .action(async (name: string, opts) => {
    try {
      const globalOpts = program.opts();

      if (opts.serviceEnvironment && !SERVICE_ENVIRONMENT_TIERS.includes(opts.serviceEnvironment)) {
        throw new Error(
          `Unknown --service-environment "${opts.serviceEnvironment}". Valid: ${SERVICE_ENVIRONMENT_TIERS.join(", ")}`
        );
      }
      if (!globalOpts.clientId) {
        throw new Error("--client-id <id> is required.");
      }

      const entry: EnvironmentConfigEntry = {
        apiBase: opts.apiBase,
        agentOpsUrl: globalOpts.agentOpsUrl,
        mcpOpsUrl: globalOpts.mcpOpsUrl,
        reviewUrl: globalOpts.reviewUrl,
        gatewayUrl: globalOpts.gatewayUrl,
        iamUrl: globalOpts.iamUrl,
        connectorHostUrl: globalOpts.connectorHostUrl,
        clientId: globalOpts.clientId,
        marketplaceUrl: opts.marketplaceUrl,
        label: opts.label,
        serviceEnvironment: opts.serviceEnvironment,
      };

      const preset = await upsertEnvironmentConfigEntry(name, entry);
      process.stdout.write(`Added environment "${preset.name}" to ${getEnvironmentConfigPath()}\n`);
      process.stdout.write(`  Agent Ops: ${preset.agentOpsUrl}\n`);
      process.stdout.write(`  MCP Ops:   ${preset.mcpOpsUrl}\n`);
      process.stdout.write(`  Review:    ${preset.reviewUrl}\n`);
      process.stdout.write(`  Gateway:   ${preset.gatewayUrl}\n`);
      process.stdout.write(`  IAM:       ${preset.iamUrl}\n`);
      process.stdout.write(`  Connector: ${preset.connectorHostUrl}\n`);
      process.stdout.write(
        `Run \`novaos-cli --env ${preset.name} env show\` to verify, or ` +
          `\`novaos-cli env use ${preset.name}\` to make it active.\n`
      );
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

/** Display order/labels for env show's per-field output (plain and --verbose). */
const URL_FIELD_LABELS: Array<[keyof EnvironmentUrls, string]> = [
  ["agentOpsUrl", "Agent Ops"],
  ["mcpOpsUrl", "MCP Ops"],
  ["reviewUrl", "Review"],
  ["gatewayUrl", "Gateway"],
  ["iamUrl", "IAM"],
  ["connectorHostUrl", "Connector Host"],
  ["clientId", "Client ID"],
];

/** Pads "<Label>:" to a fixed column so values line up, matching env show/use's existing style. */
function formatFieldLabel(label: string): string {
  return `${label}:`.padEnd(11);
}

function formatEnvSource(source: EnvironmentSource): string {
  switch (source) {
    case "flag":
      return "from --env flag";
    case "env":
      return "from NOVAOS_ENV";
    case "config":
      return "from ~/.novaos/config.json";
    case "default":
      return "default";
  }
}

function formatFieldSource(field: ResolvedField): string {
  switch (field.source) {
    case "flag":
      return `flag: ${field.flag}`;
    case "env":
      return `env var: ${field.envVar}`;
    case "preset":
      return field.presetOrigin === "config-file"
        ? `preset: ${getEnvironmentConfigPath()}`
        : "preset: local default";
  }
}

env
  .command("show")
  .description("Show resolved URLs for the current session")
  .option(
    "--verbose",
    "Show which layer (CLI flag, env var, named-environment preset, or default) resolved each value"
  )
  .action(async (cmdOpts) => {
    try {
      const opts = program.opts();
      const resolvedEnv = await resolveActiveEnvironment(opts.env);
      // Mirrors the flag-override handling in getAgentOpsClient()/getMcpOpsClient()/etc. —
      // env show needs to reflect the same per-field CLI overrides those clients apply.
      const flagOverrides: Partial<EnvironmentUrls> = {
        agentOpsUrl: opts.agentOpsUrl,
        mcpOpsUrl: opts.mcpOpsUrl,
        reviewUrl: opts.reviewUrl,
        gatewayUrl: opts.gatewayUrl,
        iamUrl: opts.iamUrl,
        connectorHostUrl: opts.connectorHostUrl,
        clientId: opts.clientId,
      };
      const urls = resolveUrlsWithProvenance(resolvedEnv.name, flagOverrides);

      if (cmdOpts.verbose) {
        process.stdout.write(
          `Environment: ${resolvedEnv.name} (${formatEnvSource(resolvedEnv.source)})\n`
        );
        for (const [key, label] of URL_FIELD_LABELS) {
          const field = urls[key];
          process.stdout.write(
            `  ${formatFieldLabel(label)}${field.value}  (${formatFieldSource(field)})\n`
          );
        }
      } else {
        process.stdout.write(`Environment: ${resolvedEnv.name}\n`);
        for (const [key, label] of URL_FIELD_LABELS) {
          process.stdout.write(`  ${formatFieldLabel(label)}${urls[key].value}\n`);
        }
      }
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

program
  .command("init")
  .description("Scaffold a new NovaOS agent project")
  .requiredOption("--name <name>", "Agent name (lowercase, DNS-compatible)")
  .option(
    "--publisher <publisher>",
    "Publisher identity slug (default: JWT publisher_name, else Marketplace membership)"
  )
  .option("--lang <language>", "Language: typescript, python, or java", "typescript")
  .option(
    "--protocol <protocol>",
    'Adapter: "A2A" (SDK agent, default) or "REST" ("ACP" is not supported — use "A2A" instead)',
    "A2A"
  )
  .option("--dir <directory>", "Output directory (default: ./<name>; absolute paths supported)")
  .option("--force", "Overwrite existing files")
  .action(async (opts) => {
    try {
      let publisher: string;
      const explicitPublisher = opts.publisher as string | undefined;
      if (explicitPublisher) {
        publisher = explicitPublisher;
      } else {
        const identity = await whoami();
        if (identity.publisher_name) {
          publisher = identity.publisher_name;
        } else {
          const { client, env } = createMarketplaceClientForEnv(
            await getResolvedEnvName(),
            program.opts().debug ?? false
          );
          const resolved = await resolvePublisherSlugForInit({
            env,
            lookup: () => fetchPublisherLookup(client),
          });
          if (!resolved.ok) {
            process.stderr.write(resolved.message);
            process.exit(1);
          }
          publisher = resolved.publisher;
        }
      }

      const result = await agentInit({
        name: opts.name,
        publisher,
        language: opts.lang as AgentLanguage,
        protocol: opts.protocol,
        directory: opts.dir,
        force: opts.force,
      });

      process.stdout.write(`Agent project created at ${result.directory}\n`);
      process.stdout.write(`Language: ${result.language}\n`);
      if (result.protocol === "A2A") {
        process.stdout.write(`Protocol: A2A (adapter selector — this agent speaks A2A)\n`);
      }
      process.stdout.write(`Files:\n`);
      for (const file of result.files) {
        process.stdout.write(`  ${file}\n`);
      }

      // One-time heads-up (TestPyPI → production PyPI cutover gate): a
      // scaffolded Python agent depends on novaos-agent-sdk, which currently
      // has no production PyPI release.
      if (result.language === "python" && isPreCutoverIndex()) {
        process.stderr.write(PYTHON_SDK_PRE_CUTOVER_WARNING);
      }

      process.stdout.write(`\nNext steps:\n`);
      process.stdout.write(`  cd ${result.directory}\n`);
      if (result.language === "typescript") {
        process.stdout.write(`  bun install\n`);
        process.stdout.write(`  bun run start\n`);
      } else if (result.language === "python") {
        process.stdout.write(`  python3 -m venv .venv && source .venv/bin/activate\n`);
        process.stdout.write(`  pip install -r requirements.txt -r requirements-dev.txt\n`);
        process.stdout.write(`  python server.py\n`);
      } else if (result.language === "java") {
        process.stdout.write(`  mvn spring-boot:run\n`);
      }
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

program
  .command("publish")
  .description("Build, push, and submit an agent for review")
  .argument("<manifest-path>", "Path to agent manifest JSON file")
  .option("--dockerfile <path>", "Path to Dockerfile (default: <manifest-dir>/Dockerfile)")
  .option("--context <path>", "Docker build context directory (default: manifest directory)")
  .option(
    "--platform <platform>",
    "Docker target platform (default: auto-detected from host arch, e.g. linux/arm64 on Apple Silicon)"
  )
  .option("--dry-run", "Validate and authorize without building or pushing")
  .option("--json", "Machine-readable JSON output (suppresses progress)")
  .action(async (manifestPath: string, opts) => {
    try {
      await requireDeveloperRole();
      await agentPublish(await getAgentOpsClient(), {
        manifestPath,
        dockerfile: opts.dockerfile,
        context: opts.context,
        platform: opts.platform,
        envName: await getResolvedEnvName(),
        dryRun: opts.dryRun,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

program
  .command("publish-status")
  .description("Check review pipeline status for a submitted agent")
  .argument("<review-id>", "Review ID returned by novaos-cli publish")
  .option("--json", "Machine-readable JSON output")
  .option(
    "--verify",
    "Fetch the served Agent Card at the printed agent id and fail if it does not resolve"
  )
  .action(async (reviewId: string, opts) => {
    try {
      await requireDeveloperRole();
      const result = await publishStatus(await getAgentOpsClient(), reviewId, {
        json: opts.json,
        verify: opts.verify,
        gatewayClient: await getGatewayClient(),
      });
      if (opts.verify && result.cardVerified === false) process.exit(1);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

const release = program.command("release").description("Agent release management");

release
  .command("create")
  .description("Register a new agent version in a release channel")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--channel <channel>", "Release channel (canary, beta, stable)")
  .requiredOption("--version <semver>", "Version string (SemVer)")
  .option("--image-ref <ref>", "Docker image reference")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await releaseCreate(await getAgentOpsClient(), {
        agentId: opts.agent,
        channel: opts.channel,
        version: opts.version,
        imageRef: opts.imageRef,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

release
  .command("promote")
  .description("Promote latest version from one channel to another")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--from <channel>", "Source channel")
  .requiredOption("--to <channel>", "Target channel")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      await releasePromote(await getAgentOpsClient(), {
        agentId: opts.agent,
        from: opts.from,
        to: opts.to,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

release
  .command("rollback")
  .description("Roll back a release channel to the previous version")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--channel <channel>", "Release channel to roll back")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      await releaseRollback(await getAgentOpsClient(), {
        agentId: opts.agent,
        channel: opts.channel,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

release
  .command("list")
  .description("List all release versions for an agent")
  .requiredOption("--agent <id>", "Agent ID")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await releaseList(await getAgentOpsClient(), {
        agentId: opts.agent,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

const evalCmd = program.command("eval").description("Evaluation suite commands");

evalCmd
  .command("run")
  .description("Run an evaluation suite for an agent version")
  .requiredOption("--suite <id>", "Suite ID")
  .requiredOption("--agent-version <semver>", "Agent version to evaluate")
  .option("--outputs-file <path>", "Path to case outputs JSON file")
  .option("--detect-regression", "Fail with exit 3 if scores regress from baseline")
  .option("--regression-threshold <threshold>", "Score drop threshold (default: 0.05)", parseFloat)
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      const result = await evalRun(await getGatewayClient(), {
        suiteId: opts.suite,
        agentVersion: opts.agentVersion,
        outputsFile: opts.outputsFile,
        json: opts.json,
        detectRegression: opts.detectRegression ?? false,
        regressionThreshold: opts.regressionThreshold,
      });
      process.exit(result.exitCode);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(2);
    }
  });

evalCmd
  .command("list")
  .description("List recent evaluation runs for an agent")
  .requiredOption("--agent <id>", "Agent ID")
  .option("--suite-id <id>", "Filter by evaluation suite ID")
  .option("--limit <n>", "Maximum number of runs to show", "20")
  .option("--cursor <cursor>", "Pagination cursor from a previous response")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      const result = await evalList(await getGatewayClient(), {
        agentId: opts.agent,
        suiteId: opts.suiteId,
        limit: parseInt(opts.limit, 10),
        cursor: opts.cursor,
        json: opts.json,
      });
      process.exit(result.exitCode);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(2);
    }
  });

evalCmd
  .command("local")
  .description("Run an evaluation suite against a locally-running agent")
  .requiredOption("--suite <path>", "Path to evaluation suite file (YAML or JSON)")
  .option("--agent-url <url>", "Agent URL", "http://localhost:8001")
  .option("--threshold <n>", "Pass threshold (0.0-1.0)", "0.7")
  .option("--output <path>", "Write results to file")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      const result = await evalLocal({
        suitePath: opts.suite,
        agentUrl: opts.agentUrl,
        threshold: parseFloat(opts.threshold),
        output: opts.output,
        json: opts.json,
      });
      process.exit(result.exitCode);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(2);
    }
  });

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

const manifestCmd = program.command("manifest").description("Agent manifest validation");

manifestCmd
  .command("validate")
  .description("Validate an agent manifest file")
  .argument("<path>", "Path to manifest JSON file")
  .option("--json", "Output as JSON")
  .action((path: string, opts: { json?: boolean }) => {
    try {
      const content = readFileSync(path, "utf-8");
      const raw = JSON.parse(content);
      const result = validateManifest(raw);

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        if (!result.valid) process.exit(1);
      } else if (result.valid) {
        process.stdout.write(`Manifest is valid (v${result.manifest?.schema_version})\n`);
        if (result.upgraded) {
          process.stdout.write("  Note: auto-upgraded from v1 to v2\n");
        }
        if (result.warnings?.length) {
          for (const w of result.warnings) {
            process.stderr.write(`  Warning: ${w}\n`);
          }
        }
      } else {
        process.stderr.write("Manifest validation failed:\n");
        for (const err of result.errors ?? []) {
          process.stderr.write(`  ${err.path}: ${err.message}\n`);
        }
        process.exit(1);
      }
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

const mcp = program.command("mcp").description("MCP tool commands");

mcp
  .command("validate")
  .description("Validate an MCP tool manifest file")
  .argument("<path>", "Path to MCP manifest JSON file")
  .option("--json", "Output as JSON")
  .action((path: string, opts: { json?: boolean }) => {
    try {
      const content = readFileSync(path, "utf-8");
      const raw = JSON.parse(content);
      const result = validateMcpManifest(raw);

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        if (!result.valid) process.exit(1);
      } else if (result.valid) {
        process.stdout.write(
          `MCP manifest is valid: ${result.manifest?.name} v${result.manifest?.version}\n`
        );
      } else {
        process.stderr.write("MCP manifest validation failed:\n");
        for (const err of result.errors ?? []) {
          process.stderr.write(`  ${err.path}: ${err.message}\n`);
        }
        process.exit(1);
      }
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

mcp
  .command("publish")
  .description("Build, push, and submit an MCP tool version for review")
  .option("--manifest <path>", "Path to MCP manifest file", "./manifest.json")
  .option("--image-uri <uri>", "Pre-built Docker image URI (skips build/push)")
  .option("--dockerfile <path>", "Path to Dockerfile (default: <manifest-dir>/Dockerfile)")
  .option("--context <path>", "Docker build context directory (default: manifest directory)")
  .option(
    "--platform <platform>",
    "Docker target platform (default: auto-detected from host arch, e.g. linux/arm64 on Apple Silicon)"
  )
  .option("--dry-run", "Validate and authorize without building or pushing")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await mcpPublish(await getMcpOpsClient(), {
        manifestPath: opts.manifest,
        imageUri: opts.imageUri,
        dockerfile: opts.dockerfile,
        context: opts.context,
        platform: opts.platform,
        envName: await getResolvedEnvName(),
        dryRun: opts.dryRun,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

mcp
  .command("init")
  .description("Scaffold a new MCP tool server project")
  .option("--name <name>", "Tool server name (lowercase, alphanumeric + hyphens)")
  .option("--publisher <publisher>", "Publisher slug", "novaos")
  .option("--lang <language>", "Project language: typescript or python", "typescript")
  .option("--dir <path>", "Target directory (default: ./<name>; absolute paths supported)")
  .option("--force", "Overwrite existing manifest.json", false)
  .action(async (opts) => {
    try {
      const name = opts.name;
      if (!name) {
        process.stderr.write("Error: --name is required\n");
        process.exit(1);
      }
      const lang = opts.lang as "typescript" | "python";
      if (lang !== "typescript" && lang !== "python") {
        process.stderr.write(`Error: --lang must be "typescript" or "python", got "${lang}"\n`);
        process.exit(1);
      }
      const directory = opts.dir ?? `./${name}`;
      mcpInit({ name, publisher: opts.publisher, language: lang, directory, force: opts.force });
      process.stdout.write(`Scaffolded MCP tool project at ${directory}\n`);
      process.stdout.write(`  manifest.json — MCP manifest (v2.0)\n`);
      process.stdout.write(
        `  src/index.${lang === "typescript" ? "ts" : "py"} — Tool server entry\n`
      );
      process.stdout.write(`  Dockerfile — Container image\n`);
      process.stdout.write(`\nNext steps:\n`);
      process.stdout.write(`  cd ${directory}\n`);
      if (lang === "typescript") {
        process.stdout.write(`  bun install\n`);
        process.stdout.write(`  bun run dev\n`);
      } else {
        process.stdout.write(`  pip install -r requirements.txt\n`);
        process.stdout.write(`  python src/index.py\n`);
      }
      process.stdout.write(`  novaos-cli mcp validate manifest.json\n`);
      process.stdout.write(`  novaos-cli mcp publish\n`);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

mcp
  .command("invoke")
  .description("Invoke an MCP tool via the sandbox gateway")
  .requiredOption("--tool <name>", "Qualified tool name (publisher.service.tool)")
  .option("--input <json>", "Tool arguments as JSON string", "{}")
  .option(
    "--mcp-gateway-url <url>",
    "MCP Gateway URL (sandbox or deployed)",
    "http://localhost:4000"
  )
  .option("--json", "Output raw JSON response")
  .action(async (opts) => {
    try {
      const { mcpInvoke } = await import("./mcp-invoke.js");
      const result = await mcpInvoke({
        tool: opts.tool,
        input: opts.input,
        gatewayUrl: opts.mcpGatewayUrl,
        json: opts.json,
      });
      process.exit(result.exitCode);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

mcp
  .command("register")
  .description("Register an MCP tool server from a local manifest")
  .option("--manifest <path>", "Path to MCP manifest file", "./manifest.json")
  .option(
    "--url <url>",
    "Runtime URL of the already-deployed MCP tool server (overrides manifest.url)"
  )
  .option("--environment <env>", "Target environment (derived from --env when omitted)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      const { mcpRegister } = await import("./mcp-register.js");
      const cliEnv = await getResolvedEnvName();
      const registerEnv = opts.environment ?? cliEnvToServiceEnvironment(cliEnv);
      if (
        !opts.json &&
        opts.environment === "production" &&
        cliEnvToServiceEnvironment(cliEnv) !== "production"
      ) {
        process.stderr.write(
          `Warning: registering with environment=production while CLI targets '${cliEnv}'. ` +
            `Omit --environment to auto-derive '${cliEnvToServiceEnvironment(cliEnv)}' from your CLI context.\n`
        );
      }
      await mcpRegister(await getMcpOpsClient(), {
        manifestPath: opts.manifest,
        url: opts.url,
        environment: registerEnv,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

mcp
  .command("logs")
  .description("Stream Loki-backed execution logs for a deployed MCP tool server")
  .argument("<server-id>", "Service ID (UUID) for the MCP tool server")
  .option("-f, --follow", "Follow log output (SSE streaming)")
  .option("--since <duration>", "Show logs since duration (e.g. 1h, 6h, 24h, 7d)", "1h")
  .option("--limit <n>", "Maximum number of log entries (default 200, max 1000)", "200")
  .option("--run-id <id>", "Filter logs to a specific run ID")
  .option("--json", "Machine-readable JSON output")
  .action(async (serverId: string, opts) => {
    try {
      await requireDeveloperRole();
      await mcpLogs(await getMcpOpsClient(), serverId, {
        follow: opts.follow ?? false,
        since: opts.since,
        limit: parseInt(opts.limit, 10),
        runId: opts.runId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

mcp
  .command("pod-logs")
  .description(
    "Fetch container logs for a deployed MCP tool server (by Service Registry service_id)"
  )
  .argument("<service-id>", "Service ID (UUID) for the MCP tool server")
  .option("-f, --follow", "Follow log output (SSE streaming)")
  .option("--container <name>", "Container name", "mcp-server")
  .option("--tail-lines <n>", "Number of tail lines (non-follow)", "100")
  .option("--since-seconds <n>", "Only return logs newer than this many seconds")
  .option("--json", "Machine-readable JSON output")
  .action(async (serviceId: string, opts) => {
    try {
      await requireDeveloperRole();
      await mcpPodLogs(await getMcpOpsClient(), serviceId, {
        follow: opts.follow ?? false,
        container: opts.container,
        tailLines: parseInt(opts.tailLines, 10),
        sinceSeconds: opts.sinceSeconds !== undefined ? parseInt(opts.sinceSeconds, 10) : undefined,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

program
  .command("migrate")
  .description("Convert a v1.x agent manifest to v2.0 format")
  .argument("<manifest-path>", "Path to agent manifest JSON file")
  .option("--output <path>", "Output file path (default: stdout)")
  .option("--in-place", "Overwrite the original file")
  .option("--json", "Machine-readable JSON output")
  .action((manifestPath: string, opts: { output?: string; inPlace?: boolean; json?: boolean }) => {
    try {
      migrateManifest(manifestPath, opts);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

const agent = program.command("agent").description("Agent management commands");

agent
  .command("logs")
  .description("Stream Loki-backed execution logs for a deployed agent")
  .argument("<agent-id>", "Agent ID (UUID)")
  .option("-f, --follow", "Follow log output (SSE streaming)")
  .option("--since <duration>", "Show logs since duration (e.g. 1h, 6h, 24h, 7d)", "1h")
  .option("--limit <n>", "Maximum number of log entries (default 200, max 1000)", "200")
  .option("--run-id <id>", "Filter logs to a specific run ID")
  .option("--json", "Machine-readable JSON output")
  .action(async (agentId: string, opts) => {
    try {
      await requireDeveloperRole();
      await agentLogs(await getAgentOpsClient(), agentId, {
        follow: opts.follow ?? false,
        since: opts.since,
        limit: parseInt(opts.limit, 10),
        runId: opts.runId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

agent
  .command("pod-logs")
  .description("Fetch stdout/stderr from the agent's running Kubernetes pod")
  .argument("<agent-id>", "Agent ID (UUID)")
  .option("-f, --follow", "Follow pod log output (SSE streaming)")
  .option("--container <name>", 'Container name: "agent" or "auth-proxy"', "agent")
  .option("--tail-lines <n>", "Number of log lines to tail (1–10000)", "200")
  .option("--since-seconds <n>", "Only logs newer than this many seconds (1–86400)", "3600")
  .option("--json", "Machine-readable JSON output")
  .action(async (agentId: string, opts) => {
    try {
      await requireDeveloperRole();
      await agentPodLogs(await getAgentOpsClient(), agentId, {
        follow: opts.follow ?? false,
        container: opts.container,
        tailLines: parseInt(String(opts.tailLines), 10),
        sinceSeconds: parseInt(String(opts.sinceSeconds), 10),
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// shadow
// ---------------------------------------------------------------------------

const shadow = program.command("shadow").description("Shadow testing commands");

shadow
  .command("deploy")
  .description("Deploy a shadow version alongside production for A/B comparison")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--version <semver>", "Shadow version string")
  .requiredOption("--url <url>", "Shadow service URL")
  .option("--traffic-pct <pct>", "Percentage of traffic to route to shadow (1-100)", "10")
  .option("--eval-config <json>", "Evaluation config as JSON string")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      let evaluationConfig: ShadowEvaluationConfig | undefined;
      if (opts.evalConfig) {
        evaluationConfig = JSON.parse(opts.evalConfig) as ShadowEvaluationConfig;
      }
      await shadowDeploy(await getAgentOpsClient(), {
        agentId: opts.agent,
        shadowVersion: opts.version,
        shadowUrl: opts.url,
        trafficPct: parseInt(opts.trafficPct, 10),
        evaluationConfig,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

shadow
  .command("promote")
  .description("Promote the shadow version to production")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--version <semver>", "Shadow version to promote")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      await shadowPromote(await getAgentOpsClient(), {
        agentId: opts.agent,
        shadowVersion: opts.version,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

shadow
  .command("rollback")
  .description("Remove shadow deployment, restore 100% production traffic")
  .requiredOption("--agent <id>", "Agent ID")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      await shadowRollback(await getAgentOpsClient(), {
        agentId: opts.agent,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

shadow
  .command("replay")
  .description("Replay historical requests through the shadow version")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--version <semver>", "Shadow version to replay against")
  .option("--count <n>", "Number of requests to replay (1-5000)", "500")
  .option("--from-date <iso>", "Replay requests from this date (ISO 8601)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      await shadowReplay(await getAgentOpsClient(), {
        agentId: opts.agent,
        shadowVersion: opts.version,
        count: parseInt(opts.count, 10),
        fromDate: opts.fromDate,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

shadow
  .command("summary")
  .description("Show evaluation summary for a shadow deployment")
  .requiredOption("--agent <id>", "Agent ID")
  .requiredOption("--version <semver>", "Shadow version")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requirePlatformAdmin();
      await shadowSummary(await getAgentOpsClient(), {
        agentId: opts.agent,
        shadowVersion: opts.version,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------

const sandbox = program.command("sandbox").description("Local development sandbox");

sandbox
  .command("start")
  .description("Start local sandbox with mock platform services")
  .option("--llm-mode <mode>", "LLM gateway mode: echo, canned, local, openai", "echo")
  .option(
    "--agent-id <id>",
    "Agent ID for tool-health preflight (defaults: NOVAOS_AGENT_ID or manifest.json name)"
  )
  .option(
    "--version <semver>",
    "Agent version for tool-health preflight (defaults: manifest.json version)"
  )
  .option(
    "--org-id <id>",
    "Org ID for tool-health preflight (defaults: NOVAOS_ORGANIZATION_ID or novaos-cli auth org)"
  )
  .option("--strict-tools", "Abort sandbox start when restricted tools are found", false)
  .option("--cwd <dir>", "Working directory for manifest.json lookup")
  .action(async (opts) => {
    try {
      // The tool-health preflight hits connector-host directly (not through
      // getConnectorHostClient()), so it needs this resolved the same way
      // that helper does — otherwise --env/--connector-host-url are silently
      // ignored here even though every other network-calling command
      // respects them.
      const globalOpts = program.opts();
      const baseUrl = globalOpts.connectorHostUrl || (await getResolvedUrls()).connectorHostUrl;
      await sandboxStart({
        llmMode: opts.llmMode,
        agentId: opts.agentId,
        version: opts.version,
        orgId: opts.orgId,
        strictTools: opts.strictTools ?? false,
        cwd: opts.cwd,
        baseUrl,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

sandbox
  .command("stop")
  .description("Stop local sandbox")
  .option("--volumes", "Also remove data volumes")
  .action(async (opts) => {
    try {
      await sandboxStop({ removeVolumes: opts.volumes ?? false });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

sandbox
  .command("status")
  .description("Show sandbox service status")
  .action(async () => {
    try {
      await sandboxStatus();
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

import { runTests } from "./test-runner.js";

program
  .command("test")
  .description("Discover and run tests for the current agent project")
  .option("--pattern <glob>", "Filter test files by pattern (substring match)")
  .option("--sandbox", "Start sandbox before running tests (sets NOVAOS_ENV=sandbox)")
  .option(
    "--stop-sandbox-after",
    "After tests, stop sandbox if this run started it (use with --sandbox)"
  )
  .option("--verbose", "Verbose test output")
  .option("--watch", "Re-run tests on file changes")
  .option("--cwd <dir>", "Working directory for test discovery")
  .action(async (opts) => {
    try {
      const result = await runTests({
        pattern: opts.pattern,
        sandbox: opts.sandbox ?? false,
        stopSandboxAfter: opts.stopSandboxAfter ?? false,
        verbose: opts.verbose ?? false,
        watch: opts.watch ?? false,
        cwd: opts.cwd,
      });
      process.exit(result.exitCode);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

program
  .command("run")
  .description("Run agent locally and send a test request")
  .option("--port <n>", "Agent server port", "8001")
  .option("--input <text>", "Message text to send to the agent")
  .option("--sandbox", "Ensure sandbox is up and set NOVAOS_ENV=sandbox")
  .option(
    "--stop-sandbox-after",
    "After run, stop sandbox if this run started it (use with --sandbox)"
  )
  .option("--trace", "Show trace information in output")
  .option("--cwd <dir>", "Working directory")
  .action(async (opts) => {
    try {
      const { runAgent } = await import("./run.js");
      const result = await runAgent({
        port: parseInt(opts.port, 10),
        input: opts.input,
        sandbox: opts.sandbox ?? false,
        stopSandboxAfter: opts.stopSandboxAfter ?? false,
        trace: opts.trace ?? false,
        cwd: opts.cwd,
      });
      process.exit(result.exitCode);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// skill
// ---------------------------------------------------------------------------

const skill = program.command("skill").description("Skills platform commands");

skill
  .command("list")
  .description("List available skills")
  .option("--agent-id <id>", "Filter by agent ID")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await skillList(await getGatewayClient(), {
        agentId: opts.agentId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

skill
  .command("call")
  .description("Invoke a skill on an agent")
  .argument("<skill-name>", "Name of the skill to invoke")
  .requiredOption("--agent-id <id>", "Agent ID")
  .requiredOption("--input <json>", "Input arguments as JSON string")
  .option("--json", "Output as JSON")
  .action(async (skillName: string, opts) => {
    try {
      await requireDeveloperRole();
      await skillCall(await getGatewayClient(), {
        skillName,
        agentId: opts.agentId,
        input: opts.input,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// connector
// ---------------------------------------------------------------------------

const connector = program.command("connector").description("Connector management commands");

connector
  .command("list")
  .description("List registered connectors")
  .option("--publisher <name>", "Filter by publisher")
  .option("--json", "Output as JSON")
  .option(
    "--no-paginate",
    "Only fetch the first page instead of walking all results (auto-pagination is the default)"
  )
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await connectorList(await getConnectorHostClient(), {
        publisher: opts.publisher,
        json: opts.json,
        noPaginate: !opts.paginate,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

connector
  .command("init")
  .description("Scaffold a new connector project")
  .requiredOption("--name <name>", "Connector name (lowercase, DNS-compatible)")
  .requiredOption("--publisher <publisher>", "Publisher identity slug")
  .option("--template <template>", "Project template")
  .option("--dir <directory>", "Output directory (default: ./<name>; absolute paths supported)")
  .option(
    "--spec <path>",
    "Path to an OpenAPI 3.x spec file (JSON or YAML) — generates a full connector package from it instead of the stub template"
  )
  .action((opts) => {
    try {
      const result = connectorInit({
        name: opts.name,
        publisher: opts.publisher,
        template: opts.template,
        directory: opts.dir,
        spec: opts.spec,
      });
      process.stdout.write(`Connector project created at ${result.directory}\n`);
      process.stdout.write(`Files:\n`);
      for (const file of result.files) {
        process.stdout.write(`  ${file}\n`);
      }
      process.stdout.write(`\nNext steps:\n`);
      process.stdout.write(`  cd ${result.directory}\n`);
      process.stdout.write(`  bun install\n`);
      process.stdout.write(`  bun run dev\n`);
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

connector
  .command("publish")
  .description("Publish a connector to the registry")
  .argument("<manifest-path>", "Path to connector.json manifest file")
  .requiredOption("--publisher <publisher>", "Publisher identity slug")
  .option("--dry-run", "Validate without publishing")
  .option("--json", "Output as JSON")
  .option(
    "--spec <path>",
    "Path to the connector's OpenAPI 3.x spec — re-derives the SSRF allowlist baseline from it " +
      "instead of trusting connector.json's own declared_egress field (recommended)"
  )
  .action(async (manifestPath: string, opts) => {
    try {
      await requireDeveloperRole();
      await connectorPublish(await getConnectorHostClient(), {
        manifestPath,
        publisher: opts.publisher,
        dryRun: opts.dryRun,
        json: opts.json,
        specPath: opts.spec,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

connector
  .command("register <name>")
  .description("Register a connector for a tenant (configure credentials + grant entitlement)")
  .requiredOption("--tenant-id <id>", "Tenant (org) ID to grant entitlement to")
  .requiredOption("--max-tier <tier>", "Entitlement tier: raw | enriched | inferred")
  .option(
    "--credential-file <path>",
    "(recommended) Path to a file of KEY=VALUE credential lines, same format as .env. " +
      "Avoids exposing secret values in shell history or `ps`."
  )
  .option(
    "--credential-stdin",
    "(recommended) Read KEY=VALUE credential lines from stdin. " +
      "Avoids exposing secret values in shell history or `ps`.",
    false
  )
  .option(
    "--credential <KEY=VALUE>",
    "Credential field (repeatable, e.g. --credential api_key=sk_... --credential workspace_id=WS-123). " +
      "Secret values passed this way are visible in shell history and to other users via `ps` — " +
      "prefer --credential-file or --credential-stdin.",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[]
  )
  .option("--dry-run", "Print the API calls that would be made without executing them", false)
  .action(async (name: string, opts) => {
    try {
      await requirePlatformAdmin();
      await connectorRegister(await getConnectorHostClient(), {
        connectorName: name,
        tenantId: opts.tenantId,
        maxTier: opts.maxTier,
        credentials: opts.credential,
        credentialFile: opts.credentialFile,
        credentialStdin: opts.credentialStdin,
        dryRun: opts.dryRun,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

const heartbeat = program.command("heartbeat").description("Agent heartbeat management");

heartbeat
  .command("list")
  .description("List heartbeat configurations for an agent")
  .requiredOption("--agent-id <id>", "Agent ID")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await heartbeatList(await getAgentOpsClient(), {
        agentId: opts.agentId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

heartbeat
  .command("status")
  .description("Show heartbeat status for an agent")
  .requiredOption("--agent-id <id>", "Agent ID")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await heartbeatStatus(await getAgentOpsClient(), {
        agentId: opts.agentId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

heartbeat
  .command("create")
  .description("Create a new heartbeat configuration")
  .requiredOption("--agent-id <id>", "Agent ID")
  .requiredOption("--schedule <cron>", "Cron schedule expression")
  .requiredOption("--workflow <name>", "Workflow name to execute")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      await requireDeveloperRole();
      await heartbeatCreate(await getAgentOpsClient(), {
        agentId: opts.agentId,
        schedule: opts.schedule,
        workflow: opts.workflow,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

const debug = program.command("debug").description("Agent debugging and tracing");

debug
  .command("trace")
  .description("Show execution trace for a run")
  .argument("<run-id>", "Run ID to trace")
  .option("--json", "Output as JSON")
  .action(async (runId: string, opts) => {
    try {
      await requireDeveloperRole();
      await debugTrace(await getGatewayClient(), {
        runId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

debug
  .command("watch")
  .description("Watch live debug events for a run (SSE stream)")
  .argument("<run-id>", "Run ID to watch")
  .option("--json", "Output as JSON")
  .action(async (runId: string, opts) => {
    try {
      await requireDeveloperRole();
      await debugWatch(await getGatewayClient(), {
        runId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

debug
  .command("compare")
  .description("Compare two execution runs side by side")
  .argument("<run-id-1>", "First run ID")
  .argument("<run-id-2>", "Second run ID")
  .option("--json", "Output as JSON")
  .action(async (runIdA: string, runIdB: string, opts) => {
    try {
      await requireDeveloperRole();
      await debugCompare(await getGatewayClient(), {
        runIdA,
        runIdB,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

debug
  .command("breakpoint")
  .description("Attach to a debug session with breakpoint controls")
  .argument("<run-id>", "Run ID with active debug session")
  .option("--json", "Output events as JSON")
  .action(async (runId: string, opts) => {
    try {
      await requireDeveloperRole();
      await debugBreakpoint(await getGatewayClient(), {
        runId,
        json: opts.json,
      });
    } catch (error) {
      process.stderr.write(`Error: ${stringifyError(error)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parse();
