/**
 * `memory_budget` in the `novaos.platform/context` — the pre-fetch budget for
 * the SDK's `memory.assemble` call.
 *
 * The SDK's pre-fetch hook gates entirely on this key's presence: present means
 * "assemble memory before the skill runs, within these limits", absent means
 * "skip the assemble call". So whether it is attached is the whole opt-in
 * decision, and it has to be made the same way on every path that dispatches to
 * an agent pod — the Temporal worker's foreground and background activities and
 * the gateway's direct adapter path — or an agent's memory behaviour would
 * depend on which path the platform happened to pick.
 *
 * The opt-in signal is the catalog manifest's `permissions.tools` containing
 * `"memory"` (the manifest schema's `PERMISSION_TOOL_VALUES`). It is *not* the
 * DNS record's `capabilities`, which agent-dns fills from the manifest's skill
 * ids: an agent whose skill is called `memory_roundtrip` declared memory, and
 * one that happens to name a skill `memory` did not.
 */

export interface MemoryBudget {
  token_budget: number;
  latency_budget_ms: number;
}

// Platform-wide defaults: no per-tenant or per-agent budget setting exists yet.
// Once one does, `memoryBudgetFor` is where it plugs in.
const DEFAULT_MEMORY_TOKEN_BUDGET = 4000;
const DEFAULT_MEMORY_LATENCY_BUDGET_MS = 800;

/** True when a raw catalog manifest lists `memory` in `permissions.tools`.
 *  Tolerates any shape — a missing, null or malformed manifest is simply
 *  "not declared" — because the manifest is read from JSONB without a schema. */
export function manifestDeclaresMemory(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const permissions = (manifest as { permissions?: unknown }).permissions;
  if (!permissions || typeof permissions !== "object") return false;
  const tools = (permissions as { tools?: unknown }).tools;
  return Array.isArray(tools) && tools.includes("memory");
}

/** The budget to attach as `memory_budget`, or `undefined` to leave the key
 *  off the context entirely. */
export function memoryBudgetFor(memoryDeclared: boolean | undefined): MemoryBudget | undefined {
  if (memoryDeclared !== true) return undefined;
  return {
    token_budget: DEFAULT_MEMORY_TOKEN_BUDGET,
    latency_budget_ms: DEFAULT_MEMORY_LATENCY_BUDGET_MS,
  };
}
