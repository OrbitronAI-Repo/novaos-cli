/**
 * Sandbox management — wraps docker compose for local development environment.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

import { getActiveOrganizationId } from "./config.js";
import { runToolHealthPreflight } from "./tool-health-preflight.js";

const COMPOSE_FILE = "docker-compose.sandbox.yml";

/** Env var: absolute path to `docker-compose.sandbox.yml` when the agent repo lives outside the platform workspace. */
export const NOVAOS_SANDBOX_COMPOSE_FILE_ENV = "NOVAOS_SANDBOX_COMPOSE_FILE";

function findComposeFileInAncestors(): string {
  let dir = process.cwd();
  const MAX_DEPTH = 5;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const candidate = resolve(dir, COMPOSE_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `${COMPOSE_FILE} not found in ${process.cwd()} or ${MAX_DEPTH - 1} ancestor directories.\n\n` +
      `If you are running from outside the platform workspace (e.g. an agent repo),\n` +
      `set the ${NOVAOS_SANDBOX_COMPOSE_FILE_ENV} environment variable:\n\n` +
      `  export ${NOVAOS_SANDBOX_COMPOSE_FILE_ENV}=/path/to/platform-checkout/${COMPOSE_FILE}\n`
  );
}

/** Resolves the sandbox compose file: env override first, then walk ancestors from cwd. */
export function resolveSandboxComposePath(): string {
  const override = process.env[NOVAOS_SANDBOX_COMPOSE_FILE_ENV]?.trim();
  if (override) {
    const abs = resolve(override);
    if (!existsSync(abs)) {
      throw new Error(
        `${NOVAOS_SANDBOX_COMPOSE_FILE_ENV}=${override} resolved to ${abs} but file does not exist.`
      );
    }
    return abs;
  }
  return findComposeFileInAncestors();
}

/**
 * Returns true if Docker is up and at least one sandbox compose service is running.
 * Used to avoid redundant `compose up` and to decide whether this CLI invocation may tear down.
 */
export function isSandboxServicesRunning(): boolean {
  try {
    ensureDockerRunning();
  } catch {
    return false;
  }
  let composePath: string;
  try {
    composePath = resolveSandboxComposePath();
  } catch {
    return false;
  }
  const cmd = dockerComposeCmd(composePath);
  const composeDir = dirname(composePath);
  try {
    const out = execSync(`${cmd} ps --services --filter status=running`, {
      stdio: "pipe",
      encoding: "utf-8",
      cwd: composeDir,
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function dockerComposeCmd(composePath: string): string {
  return `docker compose -f "${composePath}"`;
}

function ensureDockerRunning(): void {
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    throw new Error(
      "Docker is not running. Start Docker Desktop or the Docker daemon before using the sandbox."
    );
  }
}

const VALID_LLM_MODES = ["echo", "canned", "local", "openai"] as const;

function warnLlmModePrerequisites(llmMode: string): void {
  if (llmMode === "openai" && !process.env.OPENAI_API_KEY) {
    process.stderr.write(
      "Warning: --llm-mode openai but OPENAI_API_KEY is not set. LLM calls return 502 until you export the key and restart the sandbox.\n"
    );
  }
  if (llmMode === "local") {
    process.stderr.write(
      "Warning: --llm-mode local requires Ollama listening at host.docker.internal:11434 (reachable from the sandbox container).\n"
    );
  }
  if (llmMode === "canned") {
    process.stderr.write(
      "Warning: --llm-mode canned uses SANDBOX_LLM_RESPONSES_PATH pointing at a JSON file on the host (see sandbox-llm-responses.json). Without it, unmatched prompts fall back to echo behavior.\n"
    );
  }
}

interface SandboxStartOptions {
  llmMode?: string;
  agentId?: string;
  version?: string;
  orgId?: string;
  strictTools?: boolean;
  cwd?: string;
  /** connector-host URL for the tool-health preflight, pre-resolved by the CLI (respects --env/--connector-host-url). */
  baseUrl?: string;
}

interface SandboxManifestHints {
  agent_id?: string;
  name?: string;
  version?: string;
}

async function resolveSandboxPreflightContext(opts?: SandboxStartOptions): Promise<{
  agentId: string;
  version: string;
  orgId: string;
  strictTools: boolean;
} | null> {
  const cwd = resolve(opts?.cwd ?? process.cwd());
  let agentId = opts?.agentId?.trim() || process.env.NOVAOS_AGENT_ID?.trim();
  let version = opts?.version?.trim();

  const manifestPath = join(cwd, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SandboxManifestHints;
      agentId = agentId || manifest.agent_id?.trim() || manifest.name?.trim();
      version = version || manifest.version?.trim();
    } catch {
      // Ignore unreadable manifest — preflight is skipped when identity is incomplete.
    }
  }

  const orgId =
    opts?.orgId?.trim() ||
    process.env.NOVAOS_ORGANIZATION_ID?.trim() ||
    process.env.NOVAOS_LOGTO_ORG_ID?.trim() ||
    (await getActiveOrganizationId());

  if (!agentId || !version || !orgId) {
    return null;
  }

  return {
    agentId,
    version,
    orgId,
    strictTools: opts?.strictTools ?? false,
  };
}

export async function sandboxStart(opts?: SandboxStartOptions): Promise<void> {
  ensureDockerRunning();
  const composePath = resolveSandboxComposePath();
  const cmd = dockerComposeCmd(composePath);

  const llmMode = opts?.llmMode ?? "echo";
  if (!VALID_LLM_MODES.includes(llmMode as (typeof VALID_LLM_MODES)[number])) {
    throw new Error(`Invalid --llm-mode "${llmMode}". Valid: ${VALID_LLM_MODES.join(", ")}`);
  }

  const preflightContext = await resolveSandboxPreflightContext(opts);
  if (preflightContext) {
    const { agentId, version, orgId, strictTools } = preflightContext;
    try {
      const toolHealth = await runToolHealthPreflight({
        agentId,
        version,
        orgId,
        baseUrl: opts?.baseUrl,
      });
      if (toolHealth.orgId !== orgId) {
        process.stderr.write(
          `Warning: tool health was checked for your authenticated org ${toolHealth.orgId}, ` +
            `not the requested org ${orgId}\n`
        );
      }
      if (toolHealth.restricted.length > 0) {
        process.stderr.write(
          `Warning: ${toolHealth.restricted.length} tool(s) restricted for org ${toolHealth.orgId}\n`
        );
        for (const fqn of toolHealth.restricted) {
          process.stderr.write(`  ⚠ ${fqn}  RESTRICTED\n`);
        }
        if (strictTools) {
          throw new Error("Aborting: --strict-tools is set and restricted tools were found");
        }
      }
    } catch (err) {
      if (strictTools) {
        throw err instanceof Error
          ? err
          : new Error(`Tool health preflight failed: ${String(err)}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: Tool health preflight skipped: ${message}\n`);
    }
  }

  process.stderr.write("Starting sandbox services...\n");
  warnLlmModePrerequisites(llmMode);
  execSync(`SANDBOX_LLM_MODE=${llmMode} ${cmd} up -d --wait`, { stdio: "inherit" });

  process.stderr.write("\nSandbox ready. Service URLs:\n");
  process.stderr.write("  MCP Gateway:  http://localhost:4000\n");
  process.stderr.write("  LLM Gateway:  http://localhost:4001\n");
  process.stderr.write("  Memory:       http://localhost:4002\n");
  process.stderr.write("  Auth:         http://localhost:4003\n");
  process.stderr.write(
    "  PostgreSQL:   postgresql://sandbox:sandbox@localhost:5433/novaos_sandbox\n"
  );
  process.stderr.write("  Redis:        redis://localhost:6380\n");
  process.stderr.write(`  LLM Mode:     ${llmMode}\n`);
  process.stderr.write("\nSet environment for your agent:\n");
  process.stderr.write("  export NOVAOS_ENV=sandbox\n");
}

export async function sandboxStop(opts: { removeVolumes: boolean }): Promise<void> {
  ensureDockerRunning();
  const composePath = resolveSandboxComposePath();
  const cmd = dockerComposeCmd(composePath);
  const flags = opts.removeVolumes ? " -v" : "";

  process.stderr.write("Stopping sandbox services...\n");
  execSync(`${cmd} down${flags}`, { stdio: "inherit" });
  process.stderr.write("Sandbox stopped.\n");
}

export async function sandboxStatus(): Promise<void> {
  ensureDockerRunning();
  const composePath = resolveSandboxComposePath();
  const cmd = dockerComposeCmd(composePath);
  execSync(`${cmd} ps`, { stdio: "inherit" });
}
