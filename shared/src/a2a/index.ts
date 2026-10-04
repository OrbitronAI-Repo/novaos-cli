/**
 * A2A v1.0 wire layer — the caller side.
 *
 * Lives in `shared` because NovaOS has **two** outbound A2A clients that must
 * speak byte-identical A2A: the Temporal worker's `mint-and-execute` activity
 * and the gateway's pod-calling adapter. See
 * `./wire.ts` for what the layer covers and why the gateway's *inbound* façade
 * (`packages/gateway/src/routes/a2a.schemas.ts`) is deliberately a separate
 * module rather than a third consumer of this one.
 */

export * from "./wire.js";

/**
 * A2A v1.0 Agent Card derivation from `manifest.json`. Separate
 * from the wire layer above: that module is about *calling* an agent, this one
 * is about *describing* it. Both the marketplace publish pipeline and
 * the gateway route that serves the card read it from here.
 */
export * from "./agent-card.js";

/**
 * The `novaos.platform/extensions/user-context/v1` extension —
 * how a run's resolved secrets, sealed with `../crypto`, are placed into an
 * outbound A2A request. Separate from the wire layer because it is one specific
 * agreement rather than the protocol itself; the generic activation header lives
 * in `./wire.ts` alongside the version header.
 */
export * from "./user-context-extension.js";

/**
 * The `memory_budget` sub-key of the `novaos.platform/context`: whether an
 * agent opted into memory pre-fetch (its manifest's `permissions.tools`), and
 * the budget it gets when it did. Shared so every path that dispatches to a pod
 * makes the same decision.
 */
export * from "./memory-budget.js";
