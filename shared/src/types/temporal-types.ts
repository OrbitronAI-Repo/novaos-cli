/**
 * Shared Temporal workflow input types.
 *
 * Canonical definitions formerly lived in temporal-worker/src/types.ts.
 * This file is the single source of truth; gateway and temporal-worker import from here.
 */

export interface AgentResourceOverrides {
  /** Memory in megabytes (maps to K8s resource limits). */
  memoryMb?: number;
  /** CPU in millicores (maps to K8s resource limits). */
  cpuMillis?: number;
}

export interface ResolvedAgent {
  agentId: string;
  name: string;
  url: string;
  adapterType: "ACP" | "REST" | "A2A";
  /**
   * Skill ids from the agent-dns record (the manifest's
   * `metadata.capabilities[].name`), not platform capabilities or permissions.
   * Nothing that decides what the platform grants an agent should read this —
   * see `memoryDeclared` for the memory opt-in.
   */
  capabilities?: string[];
  description?: string;
  version?: string;
  /** Publisher/namespace for image derivation (default: "novaos"). Image = {publisher}/{name}:{version} */
  publisher?: string;
  /** Catalog-declared execution mode. Persistent agents are already running; ephemeral agents get a new pod; fleet agents use a pre-warmed shared pod. */
  executionMode?: "ephemeral" | "persistent" | "fleet";
  /** Catalog-declared resource requirements (from agent manifest `resources` field). */
  resourceOverrides?: AgentResourceOverrides;
  /** True when catalog enrichment failed at resolution time. */
  catalogEnrichmentFailed?: boolean;
  /**
   * The marketplace-facing agent ID (Agent.agent_id in the marketplace DB).
   * This differs from `agentId` which holds the internal ID used for DNS
   * registration. Used for pod labels (novaos.ai/agent-id) so log queries
   * (which use the marketplace ID from the developer UI URL) resolve correctly.
   */
  catalogAgentId?: string;
  /**
   * True when the catalog manifest's `permissions.tools` lists `"memory"`
   * (`manifestDeclaresMemory` in the shared a2a module). Decides
   * whether a dispatch carries `memory_budget` in its `novaos.platform/context`.
   * Unset when the manifest does not declare it, has no catalog row, or the
   * catalog lookup failed — all of which mean "no memory pre-fetch".
   */
  memoryDeclared?: boolean;
  /**
   * True when the catalog manifest sets `audit.action_tracking_enabled`
   * (`manifestHasActionTrackingEnabled` in the shared audit module),
   * read from the raw row for the same reason as `memoryDeclared`. Used by
   * dispatch paths whose workflow input carries no action-tracking flag of its
   * own.
   */
  actionTrackingEnabled?: boolean;
  /**
   * MCP servers declared in the manifest's `dependencies.mcp_servers` (raw row, like
   * `memoryDeclared`). Carried into the execution token's `mcp_servers` claim so the MCP
   * Gateway can limit the agent to them; undefined = none declared (no restriction).
   */
  mcpServers?: string[];
}
