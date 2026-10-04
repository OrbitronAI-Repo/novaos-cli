/**
 * A2A v1.0 Agent Card — derivation from `manifest.json`.
 *
 * ## Why this exists
 *
 * Neither of NovaOS's two agent registries is the source of truth for what an
 * agent is: `manifest.json` is. The marketplace catalog and the agent
 * registrar both derive from it, today independently and with subtly
 * different rules. The Agent Card is a *generated
 * artifact* of that same document rather than a fourth hand-maintained
 * description, and this module is the one place the marketplace derives it.
 *
 * ## The Python twin, and why a second implementation is deliberate
 *
 * The Python agent SDK's `agent_card.py` (built on
 * `AgentBuilder.to_agent_card()`) is the *runtime-side* generator: it imports a live agent's `server.py`-shaped
 * module and prints the card the exact skill registry it routes against would
 * produce. `novaos-cli publish` runs that emitter against the image it just
 * built and passes its `skills[]` / `capabilities.streaming` into this
 * module's `buildAgentCard` as a third argument — see the runtime-emission
 * notes below. This module is the one place that
 * *merges* a manifest's own fields with whatever the runtime supplied, or
 * falls back to deriving `skills[]` from `metadata.capabilities` when no
 * runtime emission is available (a manifest published before the runtime
 * emitter existed, or an agent language the emitter cannot run against).
 *
 * The `metadata.capabilities`-derivation fallback below is a **second**,
 * independent implementation of the mapping an earlier, now-defunct
 * scaffold-time generator used to own. It stays because older manifests still carry
 * `metadata.capabilities` and this is the only place left that reads it —
 * `agent-card.test.ts`'s parity fixtures pin the mapping so it does not drift
 * on its own.
 *
 * ### Two deliberate divergences from the old `metadata.capabilities` mapping
 *
 * Skill-id disambiguation. The now-defunct scaffold-time generator counted
 * collisions per *base* slug and never recorded the suffixed id it generated,
 * so capabilities named `report`, `report`, `report-2` were all assigned ids
 * from that counter and two of them came out as `report-2` — the duplicate
 * the suffixing exists to prevent. `buildSkills` below tracks emitted ids
 * instead, which is why this is a divergence rather than a bug shared by both.
 *
 * `capabilities.pushNotifications` is always `true`, never derived from anything a manifest or a runtime emission
 * declares. The gateway's A2A façade serves the four
 * `TaskPushNotificationConfig` methods for every agent behind it — backed by
 * the Temporal worker's Redis store, not by anything a pod implements — so
 * this is a platform capability, not a per-agent one. Per spec §3.3.4,
 * getting this wrong is a conformance failure, not a cosmetic one: a client
 * that reads `false` is entitled to answer every one of those four calls
 * locally with `PushNotificationNotSupportedError` rather than ever reaching
 * the gateway. This holds even when the `runtime` argument (below) is
 * supplied: `AgentBuilder.supports_push_notifications` is a *pod-level*
 * truth — did this instance get a `push_notification_store` — and wiring that
 * into the served card would silently reintroduce the bug of declaring `false`
 * for every agent that has not separately opted into one.
 *
 * `buildAgentCard` is *not* the primary path for an agent published through
 * `galaxy agent publish`: when the publisher submits the card
 * their agent was actually built against, that card is ingested verbatim and
 * this derivation never runs. See `resolveAgentCard`.
 *
 * ## Spec version
 *
 * A2A **v1.0.0**, pinned — not `latest`, and emphatically not v0.3 (an easy
 * mistake to make, since older spec revisions are still widely referenced).
 * v1.0 moved its normative type definitions into the spec's
 * `a2a.proto`, so the JSON binding is the proto3 JSON mapping: `lowerCamelCase`
 * keys, `supportedInterfaces` rather than a bare `url`, and `securitySchemes`
 * values wrapped in their `oneof` variant name (`httpAuthSecurityScheme`).
 *
 * ## What this module does NOT do
 *
 * No agent pod serves `/.well-known/agent-card.json` — pods are never
 * internet-reachable. Hosting that route is the gateway's job, reading the
 * card this module produced off the catalog row.
 *
 * Nor does it describe how an *external* caller authenticates to the gateway.
 * The `novaos_exec` scheme below is real, but it is the
 * credential a NovaOS-minted call to an agent *pod* carries, not what an
 * external A2A client presents to the gateway itself — that is Logto OAuth2
 * client-credentials, a deployment-specific fact this environment-agnostic
 * module has no issuer URL to describe. `packages/gateway/src/routes/agent-card.ts`
 * swaps the scheme for the real OAuth2/OIDC pair when it serves a card
 * externally, the same way it rewrites `supportedInterfaces` there instead of
 * here.
 */

import { z } from "zod";

/**
 * A2A specification release this generator targets, pinned deliberately.
 *
 * Mirrors `A2A_SPEC_VERSION` in `agent_card.py`, and the same `"1.0"` the
 * caller-side wire layer sends in `A2A-Version` (see `./wire.ts`) — Major.Minor
 * is the form both the header and `protocolVersion` take.
 */
export const A2A_SPEC_VERSION = "1.0" as const;

/**
 * A2A protocol binding a NovaOS agent pod serves. The spec defines GRPC and
 * HTTP+JSON as the alternatives; NovaOS wires up neither.
 */
export const A2A_PROTOCOL_BINDING = "JSONRPC" as const;

/**
 * Name of the security scheme describing the NovaOS execution token. Every call
 * reaching an agent pod carries one — minted per run by the marketplace,
 * injected by the gateway — so `buildAgentCard` advertises that and nothing
 * else, and that fact stays true regardless of who is calling.
 *
 * It is not, however, what an *external* A2A caller presents to reach the
 * gateway in the first place — that hop is Logto OAuth2 (see
 * {@link NOVAOS_OAUTH2_SCHEME}). `packages/gateway/src/routes/agent-card.ts`
 * replaces this scheme with the OAuth2/OIDC pair below when it serves a card
 * externally, for the same reason it rewrites `supportedInterfaces` there
 * rather than here: this module has no deployment configuration to draw a
 * real Logto issuer URL from, and an execution token is a credential no
 * external caller can obtain, so the two rewrites live at the one place that
 * has both the config and the audience.
 */
export const NOVAOS_SECURITY_SCHEME = "novaos_exec" as const;

/**
 * OAuth2 scope an external A2A caller's client-credentials token must carry to
 * execute an agent. The literal string, not a wildcard — it names both the OPA
 * `agent:execute` action (`packages/shared/docs/policy-engine.md`) and the
 * scope Logto is seeded with on the `urn:novaos` resource
 * (`infra/scripts/seed-logto-rbac.sh`), which is what makes the OAuth2 flow
 * below actually satisfy the gateway's authorization check rather than only
 * its authentication one.
 */
export const AGENT_EXECUTE_SCOPE = "agent:execute" as const;

/**
 * Name of the security scheme describing Logto client-credentials OAuth2 —
 * the credential an external A2A caller actually presents to the gateway.
 * Declared here so the gateway route and this module's tests share one name
 * rather than two copies of the same string.
 */
export const NOVAOS_OAUTH2_SCHEME = "novaos_oauth2" as const;

/**
 * Name of the security scheme carrying Logto's OIDC discovery document for
 * the same issuer — supplementary provider metadata (`jwks_uri`, supported
 * algorithms) for a client validating tokens itself, not an independent way
 * to authenticate. It is declared in `securitySchemes` alongside
 * {@link NOVAOS_OAUTH2_SCHEME} but is not itself listed in
 * `securityRequirements`.
 */
export const NOVAOS_OIDC_SCHEME = "novaos_oidc" as const;

/** Media types a scaffolded agent handles unless its manifest says otherwise. */
export const DEFAULT_INPUT_MODES: readonly string[] = ["text/plain"];
export const DEFAULT_OUTPUT_MODES: readonly string[] = ["text/plain"];

/**
 * `supportedInterfaces[0].url` when neither an explicit `agentUrl` nor the
 * manifest's own `url` is available.
 *
 * A2A marks `AgentInterface.url` REQUIRED, but a manifest describes a
 * publishable artifact, not a live instance — a fleet-scheduled or ephemeral
 * agent has no static address to report honestly at manifest-authoring time,
 * and every schema-2.0 manifest across the fleet omits `url` for exactly this
 * reason. Refusing to build a card over a missing `url` therefore silently
 * dropped every one of them to `card: null` (non-fatal per this module's
 * design, but a real discovery gap). This value is never dereferenced: an
 * external caller only ever sees `packages/gateway/src/routes/agent-card.ts`'s
 * `withGatewayInterface()` rewrite, which replaces `supportedInterfaces`
 * outright with the gateway's own public endpoint before serving the card to
 * anyone. It exists purely so the stored card is spec-shaped and, if ever
 * inspected directly, self-explanatory rather than a bare empty string.
 */
export const UNSET_AGENT_INTERFACE_URL = "urn:novaos:agent-card-url-unset" as const;

/**
 * Manifest key a publisher-supplied Agent Card travels under.
 *
 * `novaos-cli publish` builds the card in-process — from the
 * manifest plus the runtime emitter's capture — rather than reading a
 * sibling file, but the marketplace publish pipeline still carries a single
 * manifest document end to end (`POST /publish/finalize` → Review Service →
 * `review.manifest`). Nesting the card under a reserved key is what lets
 * `galaxy publish` submit it without every hop in that chain
 * growing a second field.
 */
export const AGENT_CARD_MANIFEST_KEY = "agent_card" as const;

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Every shape below is `.passthrough()`.
 *
 * These schemas exist to validate a card at a *read boundary* — reading a
 * JSONB column, ingesting one a publisher submitted — not to define what A2A
 * permits. A2A v1.0 has fields this generator does not emit, and a publisher's
 * card may legitimately carry them. Stripping those on the way through the
 * catalog would silently degrade a valid card into a lesser one, which is worse
 * than passing a field NovaOS does not itself understand.
 */

/** One entry of A2A's `supportedInterfaces` — where and how to reach the agent. */
export const AgentInterfaceSchema = z
  .object({
    url: z.string(),
    protocolBinding: z.string(),
    protocolVersion: z.string(),
  })
  .passthrough();
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;

/** One named thing the agent can do. Maps 1:1 from a manifest capability. */
export const AgentSkillSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
  })
  .passthrough();
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

/**
 * `skills[]` and truthful capability flags captured from a live agent
 * Passed as `buildAgentCard`'s third argument by `novaos-cli publish` — see
 * this module's header.
 */
export interface AgentCardRuntimeSkills {
  /** Wins outright over `metadata.capabilities` when supplied. */
  skills: AgentSkill[];
  /**
   * `capabilities.streaming` only. `pushNotifications` is deliberately not
   * part of this shape — see the header's note on push notifications.
   */
  capabilities?: { streaming?: boolean };
}

/** A2A `AgentProvider` — requires *both* fields or must be omitted entirely. */
export const AgentProviderSchema = z
  .object({ organization: z.string(), url: z.string() })
  .passthrough();
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

/** An A2A v1.0 Agent Card, in the proto3 JSON binding. */
export const AgentCardSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1),
    supportedInterfaces: z.array(AgentInterfaceSchema).min(1),
    capabilities: z
      .object({
        streaming: z.boolean(),
        pushNotifications: z.boolean(),
        extendedAgentCard: z.boolean(),
      })
      .passthrough(),
    defaultInputModes: z.array(z.string()),
    defaultOutputModes: z.array(z.string()),
    skills: z.array(AgentSkillSchema).min(1),
    securitySchemes: z.record(z.unknown()),
    securityRequirements: z.array(z.record(z.unknown())),
    provider: AgentProviderSchema.optional(),
    documentationUrl: z.string().optional(),
    iconUrl: z.string().optional(),
  })
  .passthrough();
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** Raised when a manifest cannot produce a spec-valid Agent Card. */
export class AgentCardGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCardGenerationError";
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Turn a capability name into an A2A skill id.
 *
 * Skill ids are opaque to the spec, but clients log and route on them, so a
 * stable kebab-case slug beats echoing free-form prose.
 *
 * Exported for `novaos-cli publish`'s Agent Card drift check: a manifest capability name is slugified here, but the SDK's
 * `AgentBuilder.skill()` registers a `SKILL_ID` verbatim, with no equivalent
 * normalization. Comparing a declared id (always slugified) against a raw
 * runtime id therefore flags drift for a capability name and `SKILL_ID` that
 * are the same string but differ only in case or in underscore-vs-hyphen —
 * e.g. `memory_roundtrip` declared against a runtime id of `memory_roundtrip`
 * itself, once this module slugifies the declared side to
 * `memory-roundtrip`. Normalizing both sides through this same function
 * before comparing closes that false positive without changing what id is
 * actually stored on the Agent Card (`buildAgentCard` still uses `runtime`
 * skill ids verbatim when supplied).
 */
export function slugify(value: string): string {
  // Capability names come from agent manifests, which can be untrusted input.
  // Cap the length before any regex touches it so a pathological manifest
  // (a capability name that's megabytes of "-") can't cost more than a fixed
  // amount of work, regardless of how the patterns below analyze.
  const bounded = value.length > 200 ? value.slice(0, 200) : value;
  const slug = bounded
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

/**
 * Map `metadata.capabilities[]` onto A2A `skills[]`.
 *
 * A manifest capability and an A2A skill are the same idea, so the mapping is
 * direct. The manifest has no per-capability tags, so the agent-level
 * `metadata.tags` + `metadata.domains` apply to every skill — the spec requires
 * the field to be present.
 */
function buildSkills(metadata: Record<string, unknown>): AgentSkill[] {
  const capabilities = Array.isArray(metadata.capabilities) ? metadata.capabilities : [];
  const skillTags = [...stringArray(metadata.tags), ...stringArray(metadata.domains)];

  const skills: AgentSkill[] = [];
  // Every id handed out so far, suffixed ones included. Tracking the *emitted*
  // ids rather than only the base slugs is what makes the suffixing safe: a
  // per-base counter alone would hand `report`/`report`/`report-2` the id
  // `report-2` twice, because the id generated for the second capability was
  // never recorded as taken. (The now-defunct scaffold-time generator this
  // mapping was ported from had that shape — see the divergence note in this
  // module's header.)
  const usedIds = new Set<string>();
  // Where each base slug's search for a free suffix left off, so a manifest with
  // many duplicates stays linear rather than rescanning from 2 every time.
  const nextSuffix = new Map<string, number>();

  for (const capability of capabilities) {
    if (!isPlainObject(capability)) continue;
    const name = nonEmptyString(capability.name);
    if (!name) continue;

    // Two capabilities can slugify identically ("Search parts" / "search-parts").
    // Suffix rather than silently dropping one — skill ids must be unique.
    const base = slugify(name);
    let skillId = base;
    if (usedIds.has(skillId)) {
      let suffix = nextSuffix.get(base) ?? 1;
      do {
        suffix += 1;
        skillId = `${base}-${suffix}`;
      } while (usedIds.has(skillId));
      nextSuffix.set(base, suffix);
    }
    usedIds.add(skillId);

    skills.push({
      id: skillId,
      name,
      // `description` is REQUIRED on AgentSkill; fall back to the name rather
      // than emitting an invalid card for a terse manifest.
      description: nonEmptyString(capability.description) ?? name,
      tags: [...skillTags],
    });
  }

  return skills;
}

/**
 * Map `metadata.author` onto A2A `provider`, or omit it.
 *
 * `AgentProvider` requires *both* `organization` and `url`. The manifest's
 * author block carries a name and email and only sometimes a url, so an author
 * without a url yields no provider at all — an omitted optional field is valid,
 * a half-populated required one is not.
 */
function buildProvider(metadata: Record<string, unknown>): AgentProvider | undefined {
  if (!isPlainObject(metadata.author)) return undefined;
  const organization = nonEmptyString(metadata.author.name);
  const url = nonEmptyString(metadata.author.url);
  if (!organization || !url) return undefined;
  return { organization, url };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build an A2A v1.0 Agent Card from a parsed `manifest.json`.
 *
 * @param manifest Parsed manifest contents (schema 1.0 or 1.1).
 * @param agentUrl Override for the interface URL. Defaults to the manifest's
 *   `url`, for when the same manifest is deployed behind a different address
 *   than the one it was authored with — falling back to
 *   {@link UNSET_AGENT_INTERFACE_URL} when neither is present, since a
 *   schema-2.0 manifest legitimately carries no static address at all.
 * @param runtime `skills[]` (and `capabilities.streaming`) captured from a
 *   live agent. When supplied, these win outright over
 *   anything derived from `metadata.capabilities` — see this module's header.
 * @throws {AgentCardGenerationError} If a field the spec marks REQUIRED is
 *   missing from the manifest and cannot be derived from it, or if neither
 *   `runtime.skills` nor `metadata.capabilities` yields at least one skill.
 */
export function buildAgentCard(
  manifest: unknown,
  agentUrl?: string,
  runtime?: AgentCardRuntimeSkills
): AgentCard {
  if (!isPlainObject(manifest)) {
    throw new AgentCardGenerationError("manifest is not a JSON object");
  }

  const missing = (["name", "description"] as const).filter(
    (field) => !nonEmptyString(manifest[field])
  );
  if (missing.length > 0) {
    throw new AgentCardGenerationError(
      `manifest is missing required field(s): ${missing.join(", ")}`
    );
  }

  const metadata = isPlainObject(manifest.metadata) ? manifest.metadata : {};

  const skills = runtime ? runtime.skills : buildSkills(metadata);
  if (skills.length === 0) {
    throw new AgentCardGenerationError(
      runtime
        ? "the running agent registers no skills — add at least one @agent.skill() handler."
        : "manifest declares no metadata.capabilities — an Agent Card needs at " +
            "least one skill. Add a capability with a name and description."
    );
  }

  const inputModes = stringArray(metadata.default_input_modes);
  const outputModes = stringArray(metadata.default_output_modes);

  const card: AgentCard = {
    name: manifest.name as string,
    description: manifest.description as string,
    // `version` is required by A2A but only by manifest schema 1.1 — a 1.0
    // manifest legitimately has none, so fall back rather than refusing.
    version: nonEmptyString(manifest.version) ?? "0.0.0",
    supportedInterfaces: [
      {
        url: agentUrl ?? nonEmptyString(manifest.url) ?? UNSET_AGENT_INTERFACE_URL,
        protocolBinding: A2A_PROTOCOL_BINDING,
        protocolVersion: A2A_SPEC_VERSION,
      },
    ],
    capabilities: {
      // NovaOS agent pods stream task updates over SSE — but the runtime
      // emission, when present, is the truthful per-agent signal rather than
      // this platform-wide default.
      streaming: runtime?.capabilities?.streaming ?? true,
      // The gateway façade serves all four TaskPushNotificationConfig
      // methods, backed by the Temporal worker's
      // Redis-backed store — a platform capability, not something any
      // individual pod implements. Per spec §3.3.4, declaring this false (as
      // it once was) obligates every caller's client to answer all
      // four with `PushNotificationNotSupportedError`; the flag has to track
      // whether the *façade* serves them, not whether the pod does. Never
      // sourced from `runtime` — see this module's header note on push
      // notifications.
      pushNotifications: true,
      // The authenticated extended card is still nobody's opt-in feature.
      extendedAgentCard: false,
    },
    defaultInputModes: inputModes.length > 0 ? inputModes : [...DEFAULT_INPUT_MODES],
    defaultOutputModes: outputModes.length > 0 ? outputModes : [...DEFAULT_OUTPUT_MODES],
    skills,
    securitySchemes: {
      [NOVAOS_SECURITY_SCHEME]: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "JWT",
          description:
            "NovaOS execution token, minted per run by the marketplace " +
            "and injected by the gateway.",
        },
      },
    },
    // SecurityRequirement is a map of scheme name -> required scopes. The
    // execution token carries no scopes of its own, so the list is empty.
    securityRequirements: [{ schemes: { [NOVAOS_SECURITY_SCHEME]: { list: [] } } }],
  };

  const provider = buildProvider(metadata);
  if (provider) card.provider = provider;

  const documentationUrl = nonEmptyString(metadata.documentation_url);
  if (documentationUrl) card.documentationUrl = documentationUrl;

  const iconUrl = nonEmptyString(metadata.icon_url);
  if (iconUrl) card.iconUrl = iconUrl;

  return card;
}

/**
 * The `metadata.capabilities`-derived skill ids a manifest declares, or `[]`
 * if it declares none.
 *
 * Used by `novaos-cli publish`, which compares this against the
 * `skills[].id` a live agent's runtime emission actually reports, and refuses
 * to publish when a manifest declares capabilities that disagree with them —
 * silently trusting one over the other is exactly the drift this check
 * exists to catch. Never throws; an empty result just means nothing to check.
 */
export function deriveDeclaredSkillIds(manifest: unknown): string[] {
  if (!isPlainObject(manifest)) return [];
  const metadata = isPlainObject(manifest.metadata) ? manifest.metadata : {};
  return buildSkills(metadata).map((skill) => skill.id);
}

/** Outcome of resolving a manifest to the Agent Card stored on the catalog row. */
export type AgentCardResolution =
  | { card: AgentCard; source: "publisher" }
  | { card: AgentCard; source: "derived" }
  | { card: null; source: "unavailable"; reason: string };

/**
 * Resolve the Agent Card to persist for a published agent.
 *
 * Order matters. A card the publisher submitted — `novaos-cli publish`
 * carrying the card built from the agent's own runtime emission — is the card their agent was actually built and tested
 * against, so it is ingested as-is — re-deriving it here would silently
 * substitute the marketplace's opinion for the publisher's. Deriving from
 * the manifest is the fallback for every agent published before publisher
 * card submission (or runtime capture) existed.
 *
 * Resolution never throws. An Agent Card is a discovery convenience, not an
 * activation precondition: a manifest predating A2A may legitimately have no
 * `metadata.capabilities`, and refusing to activate such an agent would break
 * publishers for a field their manifest was never asked to carry. Those agents
 * simply have no card to serve until their manifest grows one (the gateway's
 * card route 404s for them), which is a strictly better outcome than a failed
 * activation.
 */
export function resolveAgentCard(manifest: unknown, agentUrl?: string): AgentCardResolution {
  if (isPlainObject(manifest)) {
    const supplied = manifest[AGENT_CARD_MANIFEST_KEY];
    if (supplied !== undefined && supplied !== null) {
      // Validate rather than trust: a card missing the fields A2A marks
      // REQUIRED is worse than no card, because a client parses it and then
      // fails somewhere further away from the cause. `.passthrough()` means
      // anything valid the publisher added beyond this survives intact.
      const parsed = AgentCardSchema.safeParse(supplied);
      if (parsed.success) {
        return { card: parsed.data, source: "publisher" };
      }
      return {
        card: null,
        source: "unavailable",
        reason: `publisher-supplied card is not a valid A2A v1.0 Agent Card: ${describeIssues(parsed.error)}`,
      };
    }
  }

  try {
    return { card: buildAgentCard(manifest, agentUrl), source: "derived" };
  } catch (err) {
    return {
      card: null,
      source: "unavailable",
      reason: err instanceof AgentCardGenerationError ? err.message : String(err),
    };
  }
}

/**
 * Render a validation failure as one operator-readable line.
 *
 * Capped, because this reason string ends up in a log field: a card that is
 * wrong in twenty ways is wrong for one underlying reason, and the first few
 * paths point at it.
 */
function describeIssues(error: z.ZodError): string {
  const MAX_ISSUES = 3;
  const shown = error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const rest = error.issues.length - MAX_ISSUES;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * Parse an Agent Card read back out of storage.
 *
 * A read boundary, in the same sense as the agent catalog's other JSONB
 * validators: the column was written by a past version of this code, and a card
 * that no longer parses should surface as "no card" rather than reaching a
 * client half-formed. Returns null for absent or unparseable values.
 */
export function parseStoredAgentCard(value: unknown): AgentCard | null {
  if (value === null || value === undefined) return null;
  const parsed = AgentCardSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
