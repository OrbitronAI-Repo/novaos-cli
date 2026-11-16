/**
 * novaos-cli — Agent List
 *
 * Lists the agents of the caller's publisher profile from the Marketplace
 * (GET /api/developer/agents), so a developer can find the agent ID that
 * `agent logs`, `agent pod-logs` and `release list --agent` require.
 */

import { z } from "zod";

import { extractErrorDetail, withRequestId, type GalaxyHttpClient } from "./http-client.js";

const PAGE_SIZE = 100;
/** Safety bound on pagination (PAGE_SIZE * MAX_PAGES agents). */
const MAX_PAGES = 50;
export const DEFAULT_AGENT_LIST_LIMIT = 50;

const AgentRowSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  version: z.string(),
  publisher: z.string().nullish(),
  status: z.string().nullish(),
  protocol: z.string().nullish(),
  release_channel: z.string().nullish(),
  created_at: z.string().nullish(),
});

const AgentListPageSchema = z.object({
  data: z.object({
    agents: z.array(AgentRowSchema),
    next_cursor: z.string().nullish(),
    has_more: z.boolean().optional(),
  }),
});

export type AgentListRow = z.infer<typeof AgentRowSchema>;

interface AgentListOptions {
  limit?: number;
  name?: string;
  json?: boolean;
}

/**
 * Reads pages of the developer agent list. With `wanted`, asks for only that many
 * rows and stops once it has them; without it, reads every page (a name filter has
 * to see all rows because the endpoint has no name parameter).
 */
async function fetchAgents(
  client: GalaxyHttpClient,
  wanted?: number
): Promise<{ agents: AgentListRow[]; hasMore: boolean }> {
  const agents: AgentListRow[] = [];
  let cursor: string | null | undefined;
  let hasMore = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining = wanted === undefined ? PAGE_SIZE : wanted - agents.length;
    const params = new URLSearchParams({ limit: String(Math.min(PAGE_SIZE, remaining)) });
    if (cursor) params.set("cursor", cursor);

    const response = await client.request<unknown>(`/api/developer/agents?${params}`);
    if (!response.ok) {
      const detail = extractErrorDetail(response.data);
      throw new Error(
        withRequestId(
          `Failed to list agents (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
          response
        )
      );
    }

    const parsed = AgentListPageSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `agents response failed contract validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`
      );
    }

    agents.push(...parsed.data.data.agents);
    cursor = parsed.data.data.next_cursor;
    hasMore = Boolean(parsed.data.data.has_more && cursor);
    if (!hasMore) break;
    if (wanted !== undefined && agents.length >= wanted) break;
  }

  return { agents, hasMore };
}

export async function agentList(
  client: GalaxyHttpClient,
  options: AgentListOptions
): Promise<void> {
  const { name, json = false } = options;
  const limit =
    Number.isInteger(options.limit) && options.limit! > 0
      ? options.limit!
      : DEFAULT_AGENT_LIST_LIMIT;

  const needle = name?.toLowerCase();
  const { agents: all, hasMore } = await fetchAgents(client, needle ? undefined : limit);
  const matched = needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all;
  const shown = matched.slice(0, limit);

  if (json) {
    process.stdout.write(JSON.stringify(shown, null, 2) + "\n");
    return;
  }

  if (shown.length === 0) {
    process.stdout.write(
      name
        ? `No agents match "${name}".\n`
        : "No agents found. Agents are listed for your publisher profile; " +
            "run `novaos-cli auth whoami` to check which one is active.\n"
    );
    return;
  }

  const rows = shown.map((a) => [a.name, a.version, a.status ?? "-", a.agent_id]);
  const header = ["NAME", "VERSION", "STATUS", "AGENT ID"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]): string =>
    cols
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  process.stdout.write(line(header) + "\n");
  for (const row of rows) process.stdout.write(line(row) + "\n");

  if (matched.length > shown.length) {
    process.stderr.write(
      `\nShowing ${shown.length} of ${matched.length} agents. ` +
        `Re-run with a higher --limit or narrow the list with --name.\n`
    );
  } else if (hasMore && !needle) {
    process.stderr.write(
      `\nShowing the first ${shown.length} agents; more exist. ` +
        `Re-run with a higher --limit or narrow the list with --name.\n`
    );
  }
}
