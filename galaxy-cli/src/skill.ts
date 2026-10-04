/**
 * novaos-cli — Skill Commands
 *
 * Provides:
 *   novaos-cli skill list [--agent-id <id>] [--json]
 *   novaos-cli skill call <skill-name> --agent-id <id> --input <json> [--json]
 *
 * Targets Gateway service (/api/v1/gateway/skills).
 * The Skills Platform APIs are not yet deployed — these commands handle
 * 404/501 gracefully with a user-friendly notice.
 */

import { GalaxyHttpClient, withRequestId } from "./http-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_API_PREFIX = "/api/v1/gateway/skills";
const PLATFORM_NOT_AVAILABLE_MSG =
  "Skills platform is not yet available. This command will work once the Skills service is deployed.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillListOptions {
  agentId?: string;
  json?: boolean;
}

export interface SkillCallOptions {
  skillName: string;
  agentId: string;
  input: string;
  json?: boolean;
}

export interface SkillEntry {
  name: string;
  description?: string;
  agent_id?: string;
  version?: string;
}

export interface SkillListResult {
  skills: SkillEntry[];
}

export interface SkillCallResult {
  success: boolean;
  output?: unknown;
  message?: string;
}

interface GatewayResponse<T> {
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function skillList(
  client: GalaxyHttpClient,
  opts: SkillListOptions
): Promise<SkillListResult> {
  const query = opts.agentId ? `?agent_id=${encodeURIComponent(opts.agentId)}` : "";
  const response = await client.request<GatewayResponse<SkillListResult>>(
    `${SKILL_API_PREFIX}${query}`
  );

  if (isPlatformUnavailable(response.status)) {
    if (opts.json) {
      printJson({ skills: [], notice: PLATFORM_NOT_AVAILABLE_MSG });
    } else {
      process.stderr.write(`${PLATFORM_NOT_AVAILABLE_MSG}\n`);
    }
    return { skills: [] };
  }

  if (!response.ok) {
    throw new Error(
      withRequestId(
        `Failed to list skills: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;

  if (opts.json) {
    printJson(result);
  } else {
    const skills = result.skills ?? [];
    if (skills.length === 0) {
      process.stdout.write("No skills found.\n");
    } else {
      for (const skill of skills) {
        process.stdout.write(`  ${skill.name}  ${skill.description ?? ""}\n`);
      }
    }
  }

  return result;
}

export async function skillCall(
  client: GalaxyHttpClient,
  opts: SkillCallOptions
): Promise<SkillCallResult> {
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(opts.input);
  } catch {
    throw new Error(`Invalid JSON input: ${opts.input}`);
  }

  const response = await client.request<GatewayResponse<SkillCallResult>>(
    `${SKILL_API_PREFIX}/call`,
    {
      method: "POST",
      body: {
        skill_name: opts.skillName,
        agent_id: opts.agentId,
        input: parsedInput,
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
        `Failed to call skill: HTTP ${response.status} — ${JSON.stringify(response.data)}`,
        response
      )
    );
  }

  const result = response.data.data;

  if (opts.json) {
    printJson(result);
  } else if (result.success) {
    process.stdout.write(`Skill "${opts.skillName}" executed successfully.\n`);
    if (result.output != null) {
      process.stdout.write(JSON.stringify(result.output, null, 2) + "\n");
    }
  } else {
    process.stderr.write(`Skill call failed: ${result.message ?? "unknown error"}\n`);
  }

  return result;
}
