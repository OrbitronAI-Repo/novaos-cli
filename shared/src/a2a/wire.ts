/**
 * A2A v1.0 wire layer — the *caller* side.
 *
 * This module owns everything about how NovaOS talks A2A *to* an agent pod: the
 * JSON-RPC 2.0 envelope, the request shapes it builds, and the response/stream
 * shapes it parses. Its callers keep their own concerns and delegate every wire
 * decision here:
 *
 *   - `packages/temporal-worker/src/activities/mint-and-execute.ts` and
 *     `mint-and-poll-background.ts` — token minting, Redis publishing,
 *     fleet retry classification, metrics.
 *   - `packages/adapters/a2a-adapter/src/adapter.ts` — the gateway's
 *     direct pod-caller: Agent DNS resolution, health probing, and the
 *     `RunEvent` stream the gateway persists.
 *
 * It lives in `shared` rather than in either caller because those two are peers:
 * both are outbound clients, both need the whole layer (not just its constant
 * table), and duplicating the parsers between them would let a fix land in one
 * and silently miss the other. Originally written inside `temporal-worker` for
 * the activity and moved here when the second caller appeared.
 *
 * ## Which A2A this is
 *
 * A2A **v1.0.0**, pinned per ADR F17 — not `latest`, and emphatically not v0.3.
 * v1.0 moved the normative type definitions into the spec's `a2a.proto`, and
 * every JSON binding carries the **proto3 JSON mapping** of those messages
 * rather than a separately-authored JSON schema. The differences that matter to
 * a caller, each of which v0.3 got a different way:
 *
 * - `Part` is a `oneof` over `text` / `data` / `raw` / `url`. A part is
 *   identified by *which content field is set* — there is no `kind` tag — with
 *   `filename`, `mediaType` and `metadata` as siblings available to every
 *   variant. ACP's nested `file: {…}` object is gone; file content is flattened
 *   onto the part itself.
 * - `Message` carries no `kind` either, and `role` serialises as the proto enum
 *   value name: `ROLE_USER` / `ROLE_AGENT`.
 * - `TaskState` serialises as `TASK_STATE_WORKING` / `TASK_STATE_COMPLETED` / …
 * - Methods are PascalCase (`SendMessage`), matching the gRPC binding (§9.1).
 *   v0.3's `message/send` earns a `-32601` from a v1.0 peer.
 * - `SendMessage`'s result is a `SendMessageResponse` oneof — `{"task": …}` or
 *   `{"message": …}` — never a bare Task.
 * - A stream frame is a `StreamResponse` oneof: `task` / `message` /
 *   `statusUpdate` / `artifactUpdate`. **There is no `final` flag any more**;
 *   terminality is read from the task state, which is the whole reason stream-close
 *   classification exists.
 * - `A2A-Version: 1.0` is mandatory (§7). An *absent* header means `0.3`, so
 *   omitting it is an explicit request for a version no NovaOS pod serves —
 *   both an `a2a-sdk` 1.x scaffolded pod and an `AgentBuilder` pod
 *   answer `-32009`.
 *
 * ## Why the gateway's inbound façade still duplicates these constants
 *
 * `packages/gateway/src/routes/a2a.schemas.ts` defines the same vocabulary for
 * the gateway's *inbound* external façade, and deliberately does not
 * import it from here. That module is a server contract: it carries
 * external-input validation (UUID-shaped ids, a rejected `tenant` field, a
 * minimum part count) that has no business constraining what a client
 * constructs, and collapsing the two would make every outbound request subject
 * to rules that exist only to defend an untrusted inbound one. The duplication
 * is pinned by test instead:
 * `packages/gateway/src/routes/a2a-vocabulary-parity.test.ts` asserts every
 * shared constant is byte-identical between the two. Treat a failure there as a
 * P0 — it means one of the two surfaces has drifted from the spec, which is
 * exactly the class of bug F18 found. This mirrors the same enforced-duplication
 * pattern the Python SDK uses for `NOVAOS_METADATA_CONTENT_TYPE`.
 */

import { z } from "zod";

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENTS_PER_REQUEST,
  decodeAttachmentData,
  resolveAttachmentFilename,
  validateChatAttachment,
} from "../attachment-upload-validation.js";
import type {
  RunArtifactFileRef,
  RunArtifactFileRejection,
  RunArtifactPayload,
} from "../models/RunEvent.js";

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/**
 * The JSON-RPC endpoint on an agent pod.
 *
 * The pod root, not ACP's `/runs`. Both kinds of NovaOS pod put it there: a
 * scaffolded pod calls `create_jsonrpc_routes(handler, "/")`, and an
 * `AgentBuilder` pod's route handler is mounted at the same place.
 * The auth-proxy sidecar forwards the path through unchanged, so the execution
 * token is still validated ahead of the agent container.
 */
export const A2A_JSONRPC_PATH = "/";

/**
 * Value of the mandatory `A2A-Version` header (spec §7, §14.2.1) — the
 * Major.Minor form, which is *not* the same string as the spec release the
 * migration pins to (v1.0.0, ADR F17). Sending the release string would be
 * invalid.
 */
export const A2A_PROTOCOL_VERSION = "1.0";

/** Header name for version negotiation. Omitting it means v0.3 to a pod. */
export const A2A_VERSION_HEADER = "A2A-Version";

/**
 * Header a caller activates A2A protocol extensions with (spec v1.0, §7).
 *
 * Spelled without an `X-` prefix: `X-A2A-Extensions` is v0.3's form, kept alive
 * only by the reference implementation's v0.3 compatibility shim. NovaOS is
 * pinned to v1.0 (ADR F17) and its pods answer `-32009` to a v0.3 caller before
 * any extension is looked at, so sending the legacy spelling would activate
 * nothing anywhere.
 *
 * The pod side reads it through `novaos_client_sdk.a2a_extensions.A2A_EXTENSIONS_HEADER`
 */
export const A2A_EXTENSIONS_HEADER = "A2A-Extensions";

export const JSONRPC_VERSION = "2.0";

/** A2A v1.0 method names (spec §5.3/§9.1) — PascalCase, not v0.3's slashes. */
export const A2A_METHODS = {
  SEND_MESSAGE: "SendMessage",
  SEND_STREAMING_MESSAGE: "SendStreamingMessage",
  /** §3.1.5 — one authoritative snapshot of a task. */
  GET_TASK: "GetTask",
  /** §3.1.6 — reconnect stream; first frame is the current snapshot. */
  SUBSCRIBE_TO_TASK: "SubscribeToTask",
  /**
   * §3.1.4 — request preemptive cancellation of a task already dispatched to
   * the pod. Takes the same `TaskIdParams`
   * shape as `GetTask` (`{id}`), so `buildTaskRequest` builds this request too.
   */
  CANCEL_TASK: "CancelTask",
  /**
   * §3.1.3 — list a caller's tasks, optionally filtered by `contextId` /
   * `status`. The non-streaming execution path never learns the
   * pod-assigned task id (it deliberately never sends one, see
   * `buildOutboundMessage`), so a cancellation on that path has no id to
   * `CancelTask` until it looks one up here.
   */
  LIST_TASKS: "ListTasks",
} as const;

/**
 * The JSON-RPC error codes NovaOS's callers branch on.
 *
 * A2A's own codes occupy -32001..-32009 (v1.0 §5.4) alongside the base
 * JSON-RPC ones. Duplicated from the gateway's table for the reason in the
 * module header, and pinned to it by `a2a-vocabulary-parity.test.ts`.
 */
export const A2A_ERROR = {
  METHOD_NOT_FOUND: -32601,
  /** A `TaskPushNotificationConfig` operation given bad params. */
  INVALID_PARAMS: -32602,
  TASK_NOT_FOUND: -32001,
  /** §3.1.7–3.1.10 — the agent does not offer push notifications. */
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  /**
   * §5.4 — a caller's `configuration.acceptedOutputModes` shares no member
   * with what this agent produces. Thrown by an agent that
   * implements its own content-negotiation check (NovaOS's SDK does not
   * enforce this generically), and must reach the caller as this code rather
   * than as a generic run failure — see `interpretTerminalTask`'s handling in
   * `mint-and-execute.ts` and `toA2ATask` in `a2a-translate.ts`.
   */
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

/**
 * Codes that mean "this peer does not implement the method", as opposed to
 * "the call failed".
 *
 * `SubscribeToTask` is optional in practice: an `AgentBuilder` pod implements
 * `SendMessage` only and answers everything else `-32004` (the same reason
 * `mint-and-execute`'s streaming path has a non-SSE branch), and a hand-rolled
 * pod server may simply not route the method at all, which is `-32601`. Neither
 * is a run failure, and both pod-callers that can meet one degrade rather than
 * fail: `mintAndPollBackground` falls back to a `GetTask` snapshot poll, and
 * `mintAndExecute`'s streaming path falls back to a single `SendMessage`.
 * Read the code off the envelope for this decision — a
 * parsed error's message string is not a reliable carrier of it.
 */
export const METHOD_UNAVAILABLE_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  A2A_ERROR.METHOD_NOT_FOUND,
  A2A_ERROR.UNSUPPORTED_OPERATION,
]);

/**
 * Codes that mean "the caller's request is permanently unacceptable to this
 * agent", as opposed to a transient failure a retry might clear.
 *
 * `CONTENT_TYPE_NOT_SUPPORTED` fires when a caller's
 * `acceptedOutputModes` shares nothing with what the agent produces — the
 * same request will be refused identically on every retry, so a pod-caller
 * that throws `AgentRunFailedError` (Temporal's default-retryable outcome)
 * for this code wastes every retry attempt before the run is finally reported
 * failed. Both pod-callers instead throw non-retryably for a code in this
 * set, and the *message* text still names the code (`JSON-RPC error -32005: …`
 * / `A2A stream error -32005: …`) so `toA2ATask` can surface it on the task
 * that reads the run back.
 */
export const CONTENT_NEGOTIATION_ERROR_CODES: ReadonlySet<number> = new Set<number>([
  A2A_ERROR.CONTENT_TYPE_NOT_SUPPORTED,
]);

/**
 * Explain a non-2xx HTTP response to the *initial* `SendMessage` /
 * `SendStreamingMessage` POST to `A2A_JSONRPC_PATH` — as opposed to a
 * JSON-RPC-level error, which is a 200 whose body is a `JsonRpcError` and is
 * classified by `A2A_ERROR` above instead.
 *
 * A 404/405 here means the pod answered *something* at that origin but has no
 * route mounted at `A2A_JSONRPC_PATH` at all — precisely what a pre-migration,
 * ACP-only image looks like, since it was built before the pod template ever
 * mounted a JSON-RPC handler there. Left as a bare `404 Not Found`, that is
 * indistinguishable from a misconfigured URL or an ingress swallowing the
 * request, and sends whoever reads the run's error looking in the wrong place.
 * Every other status is passed through unchanged: they are
 * not this specific, previously-seen shape of failure.
 */
/**
 * Whether a non-2xx status on the initial A2A POST means the pod has no route
 * at `A2A_JSONRPC_PATH`. That is a property of the image, so retrying the
 * request against the same pod cannot succeed.
 */
export function isMissingA2ARouteStatus(status: number): boolean {
  return status === 404 || status === 405;
}

export function describeA2ATransportFailure(
  status: number,
  statusText: string,
  body: string
): string {
  const suffix = body ? ` — ${body}` : "";
  if (isMissingA2ARouteStatus(status)) {
    return (
      `${status} ${statusText}${suffix} (no A2A route at "${A2A_JSONRPC_PATH}" on this pod — ` +
      `it is likely a pre-A2A image that has not been rebuilt/republished on the A2A SDK)`
    );
  }
  return `${status} ${statusText}${suffix}`;
}

/** `Message.role`, as the proto enum's value names (v1.0). */
export const A2A_ROLE = {
  USER: "ROLE_USER",
  AGENT: "ROLE_AGENT",
} as const;

/** `TaskState`, as the proto enum's value names (v1.0 §4.1.2). */
export const A2A_TASK_STATE = {
  UNSPECIFIED: "TASK_STATE_UNSPECIFIED",
  SUBMITTED: "TASK_STATE_SUBMITTED",
  WORKING: "TASK_STATE_WORKING",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  AUTH_REQUIRED: "TASK_STATE_AUTH_REQUIRED",
  COMPLETED: "TASK_STATE_COMPLETED",
  CANCELED: "TASK_STATE_CANCELED",
  FAILED: "TASK_STATE_FAILED",
  REJECTED: "TASK_STATE_REJECTED",
} as const;

export type A2ATaskState = (typeof A2A_TASK_STATE)[keyof typeof A2A_TASK_STATE];

/**
 * States after which a task emits no further updates.
 *
 * `INPUT_REQUIRED` is deliberately **not** here even though the SSE stream also
 * closes after it (confirmed by an A2A maintainer on
 * [a2aproject/A2A#1503](https://github.com/a2aproject/A2A/issues/1503)). It is a
 * pause, not an end: the task continues once the caller supplies something.
 * Adding it to this set is precisely the misclassification the terminal-state classification exists to
 * prevent — see `INTERRUPT_TASK_STATES`.
 */
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set<string>([
  A2A_TASK_STATE.COMPLETED,
  A2A_TASK_STATE.FAILED,
  A2A_TASK_STATE.CANCELED,
  A2A_TASK_STATE.REJECTED,
]);

/**
 * States where the task has paused *for the caller* and will continue once the
 * caller responds. The stream closes on these too, which is why they need their
 * own branch rather than falling through to the terminal check.
 */
export const INTERRUPT_TASK_STATES: ReadonlySet<string> = new Set<string>([
  A2A_TASK_STATE.INPUT_REQUIRED,
  A2A_TASK_STATE.AUTH_REQUIRED,
]);

export const isTerminalTaskState = (state: string): boolean => TERMINAL_TASK_STATES.has(state);
export const isInterruptTaskState = (state: string): boolean => INTERRUPT_TASK_STATES.has(state);

/**
 * Namespaced metadata key carrying the NovaOS platform execution context.
 *
 * A2A has no field for host-platform context, so NovaOS claims one
 * vendor-namespaced key inside the request `metadata` map. Under ACP this same
 * payload was a top-level `body.context` object.
 *
 * ⚠️ **Must match `novaos_client_sdk.agent_context.NOVAOS_CONTEXT_METADATA_KEY`.**
 * A2A gives a caller two places to attach metadata — the request `params` and
 * the `message` — and the SDK reads `params.metadata` first. The platform sets
 * it there.
 *
 * ⚠️ **Nothing sensitive belongs in here.** The extension mechanism provides no
 * encryption of its own, so this is plain JSON in the request body,
 * visible to the same infrastructure a header would be. Per-run secret delivery
 * is handled by the `user-context/v1` extension and the encryption
 * subsystem — see the note in `executeSync` about what was removed.
 *
 * ## `idempotency_key` — agent execution is at-least-once
 *
 * The context carries an `idempotency_key` on the streaming execution path.
 * NovaOS retries `mintAndExecute` (`maximumAttempts: 2`) when a stream ends
 * without a terminal task state, which it cannot distinguish from a stream that
 * dropped *after* the agent finished its work. **An agent may therefore be asked
 * to run the same logical request twice**, and an agent with side effects —
 * writing to an external system, calling a paid API — must deduplicate on this
 * key to be correct.
 *
 * Use `idempotency_key`, not `run_id`, for that: `run_id` is stable across
 * attempts but is *not* unique per execution, because a HITL continuation reuses
 * the runId of the turn that raised the request. Deduping on `run_id` would skip
 * a legitimate second execution.
 *
 * The key is absent when the caller supplies none, so a pod that ignores it
 * behaves exactly as it did before the field existed.
 */
export const NOVAOS_CONTEXT_METADATA_KEY = "novaos.platform/context";

/**
 * Extract a caller's own `novaos.platform/context` object from an A2A
 * `SendMessage` request, honouring the same precedence the pod-side SDK reads
 * it with.
 *
 * `novaos_client_sdk.agent_context.novaos_context_from_metadata` takes the
 * first candidate metadata map — `params.metadata`, then `message.metadata` —
 * that has a dict at this key, and returns *that whole object*: it is not a
 * per-key merge across the two placements. This mirrors that exactly, so a
 * caller who puts a `novaos.platform/context` in both places sees the same one
 * "win" here as would win if the platform ever forwarded their metadata to the
 * pod unfiltered — which it does not (see `sanitizeCallerContext` below).
 *
 * Returns `undefined` when neither placement carries an object at this key, so
 * the common case (no caller context at all) has nothing to attach to the
 * outbound request.
 */
export function extractCallerContext(
  paramsMetadata: Record<string, unknown> | undefined,
  messageMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  for (const candidate of [paramsMetadata, messageMetadata]) {
    const context = candidate?.[NOVAOS_CONTEXT_METADATA_KEY];
    if (context && typeof context === "object" && !Array.isArray(context)) {
      return context as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Sub-keys of a caller-supplied `novaos.platform/context` the platform will
 * ever forward into the `novaos.platform/context` it builds for the pod.
 *
 * This is the security boundary between a caller's own metadata and the
 * platform-authoritative context `buildNovaosContext`
 * (temporal-worker/mint-and-execute.ts) and `buildDispatchContext`
 * (temporal-worker/mint-and-poll-background.ts) assemble from trusted
 * workflow inputs — `run_id`, `tenant_id`, `user_id`, `instance_id`,
 * `agent_name`, `session_id`, `trace_id`, `idempotency_key`, `history`, and
 * `iamScopes`-derived claims elsewhere. None of those names appear here on
 * purpose: a caller sending `{"novaos.platform/context": {"tenant_id": "..."}}`
 * must never be able to relabel which tenant, run, or user its own request
 * executes as. Only `schema` — the caller's structured-output request,
 * already caller-supplied on the direct `/api/v1/execute` path (Ex10) — is
 * something a caller is allowed to say about its own request.
 *
 * `sanitizeCallerContext` is the only place this list is applied; every
 * caller of `extractCallerContext` above must run its result through this
 * before letting it anywhere near the platform-built context.
 */
const CALLER_PERMITTED_CONTEXT_KEYS: ReadonlySet<string> = new Set(["schema"]);

/** Drop every sub-key of a caller `novaos.platform/context` object except the
 *  ones {@link CALLER_PERMITTED_CONTEXT_KEYS} allows. Safe to call more than
 *  once on the same value — it is idempotent. */
export function sanitizeCallerContext(
  raw: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const key of CALLER_PERMITTED_CONTEXT_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * Message-metadata key selecting which skill runs.
 *
 * ⚠️ **Shared literal across three implementations** — this module, the Python
 * SDK's `AgentBuilder` (`SKILL_ID_METADATA_KEY`), and the Galaxy scaffold's
 * `SkillRegistry` (`templates/server/skills.py::SKILL_ID_KEY`). A2A has no
 * dedicated "which skill" field on `SendMessage`, so all three must agree on
 * where the selector lives or a caller would need to know which kind of pod it
 * is calling. Do not rename one side alone.
 *
 * NovaOS's callers set it on the **message** metadata, which is the only
 * placement the scaffold's dispatcher reads. `AgentBuilder` accepts it there, on
 * the request metadata, and as `config.skill` inside the NovaOS context; the
 * callers still send `config.skill` as well, so a pod that only understands the
 * older platform plumbing keeps routing correctly.
 */
export const SKILL_ID_METADATA_KEY = "skillId";

/**
 * Vendor content-type the NovaOS SDK uses to mark a part as structured platform
 * metadata (HITL, error, progress) rather than displayable content.
 *
 * ⚠️ Must match `novaos_client_sdk.agent_builder.NOVAOS_METADATA_CONTENT_TYPE`.
 */
export const NOVAOS_METADATA_CONTENT_TYPE = "application/vnd.novaos.metadata+json";

/**
 * Where that content-type lives on an A2A part.
 *
 * A2A's `DataPart` has no content-type field of its own (unlike ACP's
 * `MessagePart`), so the SDK carries the vendor content-type as the value of
 * this key in the part's own `metadata`.
 *
 * ⚠️ Must match `novaos_client_sdk.agent_builder.NOVAOS_METADATA_PART_KEY`.
 */
export const NOVAOS_METADATA_PART_KEY = "novaos.platform/content-type";

/**
 * Vendor content-type the NovaOS SDK uses to mark a part as a skill's own
 * structured result, folded in from `SkillResult.metadata` by
 * `AgentBuilder._agent_message`.
 *
 * **Deliberately distinct from `NOVAOS_METADATA_CONTENT_TYPE`.**
 * That marker means "platform metadata" — HITL, OAuth, write-confirmation,
 * `skill_error`, progress — and `drainParts` never surfaces a marker-tagged
 * part as caller-visible `data`, because platform metadata is not the skill's
 * answer. Before this constant existed, `_agent_message` tagged the fold-in
 * with the platform marker too, so a caller who returned `SkillResult(output=…,
 * metadata={…})` — the SDK's own endorsed shortcut for structured results —
 * had that data silently excluded from `GET /api/v1/service/runs/{id}`, while
 * a skill that called `ctx.task_updater.add_artifact` manually with an
 * untagged `DataPart` had its data surface normally. Same intent, two SDK
 * paths, two outcomes. This marker gives the fold-in path its own identity so
 * `drainParts` can tell "the platform's business" from "the skill's business"
 * apart and treat the skill's own result as data, the way the manual path
 * always did.
 *
 * ⚠️ Must match `novaos_client_sdk.agent_builder.NOVAOS_SKILL_METADATA_CONTENT_TYPE`.
 */
export const NOVAOS_SKILL_METADATA_CONTENT_TYPE = "application/vnd.novaos.skill-metadata+json";

/** Key inside the NovaOS metadata part carrying a skill's error string. */
export const NOVAOS_SKILL_ERROR_KEY = "skill_error";

// ---------------------------------------------------------------------------
// Outbound shapes
// ---------------------------------------------------------------------------

/** One A2A v1.0 `Part`. Exactly one content field is set — it is a `oneof`. */
export type A2AOutboundPart = {
  text?: string;
  data?: Record<string, unknown>;
  raw?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
};

export type A2AOutboundMessage = {
  messageId: string;
  role: (typeof A2A_ROLE)[keyof typeof A2A_ROLE];
  parts: A2AOutboundPart[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
};

export type JsonRpcRequestBody = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** Default media type A2A assumes for a text part when none is declared. */
export const DEFAULT_TEXT_MEDIA_TYPE = "text/plain";

/**
 * Build the `A2A-Version` header pair.
 *
 * Its own function so no call site can construct a request and forget it: a
 * header-less call is rejected by every kind of NovaOS pod (F18 for scaffolded
 * pods, F19 for `AgentBuilder` ones), and the failure would surface as a
 * `-32009` from the pod rather than as anything obviously missing at the caller.
 */
export function a2aVersionHeader(): Record<string, string> {
  return { [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION };
}

/**
 * Build the `A2A-Extensions` header pair for the extensions a request activates.
 *
 * Deduplicated and **sorted**, matching the pod side's
 * `extensions_header_value` and the reference implementation's
 * `with_a2a_extensions`. Sorting is not cosmetic: it makes the header a
 * function of the *set* of extensions rather than of the order a caller happened
 * to assemble them in, so a request is byte-identical across runs and a test can
 * assert on it without pinning that order.
 *
 * Returns an **empty object** when nothing is activated, so a caller merges the
 * result unconditionally and still sends no header — an empty header line is a
 * request to activate nothing, spelled the long way, and NovaOS pods would read
 * it as a negotiation that produced nothing rather than as no negotiation.
 */
export function a2aExtensionsHeader(uris: readonly string[]): Record<string, string> {
  const value = [...new Set(uris.map((uri) => uri.trim()).filter(Boolean))].sort().join(",");
  return value ? { [A2A_EXTENSIONS_HEADER]: value } : {};
}

/**
 * Convert message text plus optional attachments into A2A v1.0 parts.
 *
 * The text part always comes first and always carries an explicit `mediaType` —
 * v1.0 has a real field for it, so the ACP-era workaround of stashing the media
 * type in `metadata` is gone.
 *
 * File attachments flatten onto the part: inline base64 becomes `raw`, a URL
 * becomes `url`, and `filename` / `mediaType` sit alongside. There is no nested
 * `file` object in v1.0.
 */
export function buildA2AParts(
  text: string,
  attachments?: Array<{ type?: string; data?: string; url?: string; name?: string }>
): A2AOutboundPart[] {
  const parts: A2AOutboundPart[] = [{ text, mediaType: DEFAULT_TEXT_MEDIA_TYPE }];

  for (const att of attachments ?? []) {
    const part: A2AOutboundPart = {
      mediaType: att.type || "application/octet-stream",
    };
    if (att.data) {
      // Strip a `data:` URI prefix if the caller sent one — `raw` is bare base64.
      part.raw = att.data.includes(",") ? att.data.split(",")[1]! : att.data;
    } else if (att.url) {
      part.url = att.url;
    } else {
      // A oneof with no member set is not a valid Part; a pod's parser rejects
      // the whole message rather than this one part, so an attachment carrying
      // neither content nor a URL is dropped instead of poisoning the request.
      continue;
    }
    if (att.name) {
      part.filename = att.name;
    }
    parts.push(part);
  }

  return parts;
}

/**
 * Build the JSON-RPC 2.0 request body for `SendMessage` /
 * `SendStreamingMessage`.
 *
 * `configuration.returnImmediately` is sent explicitly as `false` on both
 * methods. v1.0 replaced v0.3's `configuration.blocking` and **inverted the
 * sense**, so `false` here means "do not return until the task is terminal or
 * interrupted" — which is what every blocking NovaOS path wants: the sync path
 * needs the finished task in the response, and the streaming path needs the SSE
 * connection held open. `false` is also the spec's own default; sending it
 * explicitly documents the intent and costs nothing, and both kinds of NovaOS
 * pod accept it (an `AgentBuilder` pod runs the skill inline and so honours it
 * exactly; a scaffolded pod's `DefaultRequestHandler` blocks until terminal).
 *
 * `mintAndPollBackground` is the one caller that passes
 * `returnImmediately: true`: it wants the task id back straight away and then
 * follows the task with `SubscribeToTask`, so holding the dispatch connection
 * open for the whole run — potentially hours — is exactly what it must not do.
 */
export function buildSendMessageRequest(args: {
  method: string;
  requestId: string;
  message: A2AOutboundMessage;
  /** Goes into `params.metadata` — the placement the SDK reads first. */
  requestMetadata?: Record<string, unknown>;
  /**
   * v1.0's replacement for v0.3's `blocking`, with the sense inverted:
   * `true` returns as soon as the task exists. Defaults to `false`, which is
   * both the spec's default and what the two synchronous paths want.
   */
  returnImmediately?: boolean;
  /**
   * §5.4 content negotiation — the output modes the caller declared it can
   * accept. Sent only when non-empty: an empty array is the SDK's spelling of
   * "no restriction", the same thing as omitting the field, and emitting `[]`
   * would ask the agent to negotiate down to nothing rather than leaving it
   * unconstrained.
   */
  acceptedOutputModes?: string[];
  /** §3.7 hint carried on the *create* call, not just `GetTask`. */
  historyLength?: number;
}): JsonRpcRequestBody {
  const configuration: Record<string, unknown> = {
    returnImmediately: args.returnImmediately === true,
  };
  if (args.acceptedOutputModes && args.acceptedOutputModes.length > 0) {
    configuration.acceptedOutputModes = args.acceptedOutputModes;
  }
  if (typeof args.historyLength === "number") {
    configuration.historyLength = args.historyLength;
  }

  const params: Record<string, unknown> = {
    message: args.message,
    configuration,
  };
  if (args.requestMetadata && Object.keys(args.requestMetadata).length > 0) {
    params.metadata = args.requestMetadata;
  }

  return {
    jsonrpc: JSONRPC_VERSION,
    id: args.requestId,
    method: args.method,
    params,
  };
}

/**
 * Build the JSON-RPC body for a task-addressed method — `GetTask` or
 * `SubscribeToTask`.
 *
 * Both take the task id in `params.id`, the same placement the gateway's own
 * `TaskQueryParams` / `TaskIdParams` accept on the inbound side, so
 * NovaOS speaks one shape in both directions.
 *
 * `historyLength` is sent only when a caller asks for it. It is a *hint*: §3.7
 * lets an agent decline to persist message history at all, so nothing may be
 * relied on coming back — see `recoverInterruptPayload` for how the background poller treats what
 * does arrive.
 */
export function buildTaskRequest(args: {
  method: string;
  requestId: string;
  taskId: string;
  historyLength?: number;
}): JsonRpcRequestBody {
  const params: Record<string, unknown> = { id: args.taskId };
  if (typeof args.historyLength === "number") params.historyLength = args.historyLength;

  return {
    jsonrpc: JSONRPC_VERSION,
    id: args.requestId,
    method: args.method,
    params,
  };
}

/**
 * Build the JSON-RPC body for `ListTasks` (§3.1.3).
 *
 * Its one caller wants exactly one thing: the caller's task
 * currently `TASK_STATE_WORKING` in a given `contextId`, so it can be told to
 * `CancelTask`. `pageSize` is sent only when a caller asks for it — a
 * conversation has at most one task in flight per NovaOS's own dispatch
 * invariant (`buildOutboundMessage`), so the default page is expected to be
 * enough, but nothing here relies on that.
 */
export function buildListTasksRequest(args: {
  requestId: string;
  contextId?: string;
  status?: string;
  pageSize?: number;
}): JsonRpcRequestBody {
  const params: Record<string, unknown> = {};
  if (args.contextId) params.contextId = args.contextId;
  if (args.status) params.status = args.status;
  if (typeof args.pageSize === "number") params.pageSize = args.pageSize;

  return {
    jsonrpc: JSONRPC_VERSION,
    id: args.requestId,
    method: A2A_METHODS.LIST_TASKS,
    params,
  };
}

// ---------------------------------------------------------------------------
// Inbound shapes
// ---------------------------------------------------------------------------

/**
 * An inbound `Part`.
 *
 * Loose on purpose: this is untrusted wire data from an agent pod, and the
 * variant is identified by which content field is present rather than by a tag.
 * Unknown sibling fields pass through — a forward-compatible pod adding a
 * variant should degrade to "no text found", not fail the whole run.
 */
export const InboundPartSchema = z
  .object({
    text: z.string().nullish(),
    data: z.record(z.unknown()).nullish(),
    raw: z.string().nullish(),
    url: z.string().nullish(),
    filename: z.string().nullish(),
    mediaType: z.string().nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();
export type InboundPart = z.infer<typeof InboundPartSchema>;

export const InboundMessageSchema = z
  .object({
    messageId: z.string().nullish(),
    role: z.string().nullish(),
    parts: z.array(InboundPartSchema).nullish(),
    taskId: z.string().nullish(),
    contextId: z.string().nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const InboundTaskStatusSchema = z
  .object({
    state: z.string(),
    timestamp: z.string().nullish(),
    message: InboundMessageSchema.nullish(),
  })
  .passthrough();

export const InboundArtifactSchema = z
  .object({
    artifactId: z.string().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    parts: z.array(InboundPartSchema).nullish(),
  })
  .passthrough();
export type InboundArtifact = z.infer<typeof InboundArtifactSchema>;

export const InboundTaskSchema = z
  .object({
    id: z.string().nullish(),
    contextId: z.string().nullish(),
    status: InboundTaskStatusSchema,
    artifacts: z.array(InboundArtifactSchema).nullish(),
    history: z.array(InboundMessageSchema).nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();
export type InboundTask = z.infer<typeof InboundTaskSchema>;

/** JSON-RPC error object. A2A's own codes live in -32001..-32009 (v1.0 §5.4). */
export const JsonRpcErrorSchema = z
  .object({
    code: z.number(),
    message: z.string().nullish(),
    data: z.unknown().nullish(),
  })
  .passthrough();

export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.string().nullish(),
    id: z.union([z.string(), z.number(), z.null()]).nullish(),
    result: z.unknown().nullish(),
    error: JsonRpcErrorSchema.nullish(),
  })
  .passthrough();

/**
 * `SendMessageResponse` — a oneof, so the populated key is the discriminator.
 *
 * A pod may legitimately answer with a bare `Message` instead of a `Task` when
 * it has nothing task-shaped to report. Neither NovaOS pod does today
 * (`AgentBuilder` always wraps a Task, and a scaffolded pod's handler emits one
 * too), but the shape is part of the contract and dropping it would make a
 * conformant peer look broken.
 */
export const SendMessageResultSchema = z
  .object({
    task: InboundTaskSchema.nullish(),
    message: InboundMessageSchema.nullish(),
  })
  .passthrough();

export const InboundStatusUpdateSchema = z
  .object({
    taskId: z.string().nullish(),
    contextId: z.string().nullish(),
    status: InboundTaskStatusSchema,
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();
export type InboundStatusUpdate = z.infer<typeof InboundStatusUpdateSchema>;

export const InboundArtifactUpdateSchema = z
  .object({
    taskId: z.string().nullish(),
    contextId: z.string().nullish(),
    artifact: InboundArtifactSchema,
    append: z.boolean().nullish(),
    lastChunk: z.boolean().nullish(),
  })
  .passthrough();
export type InboundArtifactUpdate = z.infer<typeof InboundArtifactUpdateSchema>;

/**
 * One SSE frame, in v1.0's `StreamResponse` shape.
 *
 * v0.3 tagged each event with `kind: "status-update" | "artifact-update"` and a
 * `final` boolean. v1.0 wraps the payload in a oneof instead, so the populated
 * key *is* the discriminator — and there is no `final` flag, which is why
 * terminality has to be read from the task state.
 *
 * Frames arrive either bare (`{"statusUpdate": …}`) or wrapped in a JSON-RPC
 * success envelope (`{"jsonrpc":"2.0","id":…,"result":{"statusUpdate": …}}`).
 * `a2a-sdk` emits the envelope form; `parseStreamFrame` accepts both so a
 * hand-rolled pod server is not silently unreadable.
 */
export const StreamFrameSchema = z
  .object({
    task: InboundTaskSchema.nullish(),
    message: InboundMessageSchema.nullish(),
    statusUpdate: InboundStatusUpdateSchema.nullish(),
    artifactUpdate: InboundArtifactUpdateSchema.nullish(),
  })
  .passthrough();
export type StreamFrame = z.infer<typeof StreamFrameSchema>;

export type ParsedStreamFrame =
  | { kind: "task"; task: InboundTask }
  | { kind: "statusUpdate"; update: InboundStatusUpdate }
  | { kind: "artifactUpdate"; update: InboundArtifactUpdate }
  | { kind: "message"; message: InboundMessage }
  | { kind: "error"; code: number; message: string };

/**
 * Decode one SSE `data:` payload into a `StreamResponse` member.
 *
 * Returns `null` for anything unrecognisable rather than throwing: one
 * undecodable frame must not abort a run that is otherwise progressing, and the
 * caller's stream-close classification is what decides whether the run
 * actually succeeded.
 */
export function parseStreamFrame(raw: unknown): ParsedStreamFrame | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const envelope = JsonRpcResponseSchema.safeParse(raw);
  if (envelope.success && envelope.data.error) {
    return {
      kind: "error",
      code: envelope.data.error.code,
      message: envelope.data.error.message ?? `JSON-RPC error ${envelope.data.error.code}`,
    };
  }

  // A JSON-RPC-wrapped frame carries the StreamResponse under `result`; a bare
  // frame *is* the StreamResponse.
  const body =
    envelope.success && envelope.data.result && typeof envelope.data.result === "object"
      ? envelope.data.result
      : raw;

  const frame = StreamFrameSchema.safeParse(body);
  if (!frame.success) return null;

  if (frame.data.statusUpdate) return { kind: "statusUpdate", update: frame.data.statusUpdate };
  if (frame.data.artifactUpdate)
    return { kind: "artifactUpdate", update: frame.data.artifactUpdate };
  if (frame.data.task) return { kind: "task", task: frame.data.task };
  if (frame.data.message) return { kind: "message", message: frame.data.message };
  return null;
}

export type ParsedTaskResponse =
  | { kind: "task"; task: InboundTask }
  | { kind: "message"; message: InboundMessage }
  | { kind: "error"; code: number; message: string };

/**
 * Decode a single-JSON-body response that is expected to carry a `Task`.
 *
 * One function for both non-streaming calls because their result
 * shapes are deliberately different and a caller should not have to remember
 * which is which:
 *
 * - `SendMessage` answers a `SendMessageResponse` oneof — `{"task": …}` or
 *   `{"message": …}`, never a bare Task.
 * - `GetTask` answers the `Task` itself.
 *
 * A bare (un-enveloped) body is accepted too, for the same reason
 * `parseStreamFrame` accepts bare frames: a hand-rolled pod server should not be
 * silently unreadable.
 *
 * Returns `null` when the body matches nothing recognisable, so the caller
 * decides whether that is fatal — for a snapshot poll it is worth one more
 * cycle, for a dispatch it is not.
 */
export function parseTaskResponse(raw: unknown): ParsedTaskResponse | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const envelope = JsonRpcResponseSchema.safeParse(raw);
  if (envelope.success && envelope.data.error) {
    return {
      kind: "error",
      code: envelope.data.error.code,
      message: envelope.data.error.message ?? `JSON-RPC error ${envelope.data.error.code}`,
    };
  }

  const body =
    envelope.success && envelope.data.result && typeof envelope.data.result === "object"
      ? envelope.data.result
      : raw;

  // The oneof first: a `SendMessageResponse` and a bare `Task` are told apart by
  // the presence of the wrapper key, and a Task has no `task` field of its own.
  const oneof = SendMessageResultSchema.safeParse(body);
  if (oneof.success && oneof.data.task) return { kind: "task", task: oneof.data.task };
  if (oneof.success && oneof.data.message) return { kind: "message", message: oneof.data.message };

  const bare = InboundTaskSchema.safeParse(body);
  if (bare.success) return { kind: "task", task: bare.data };

  return null;
}

/** `ListTasksResponse` (§3.1.3) — a page of tasks, never a oneof. */
export const ListTasksResultSchema = z
  .object({
    tasks: z.array(InboundTaskSchema).nullish(),
    nextPageToken: z.string().nullish(),
  })
  .passthrough();

export type ParsedListTasksResponse =
  | { kind: "tasks"; tasks: InboundTask[] }
  | { kind: "error"; code: number; message: string };

/**
 * Decode a `ListTasks` response body, JSON-RPC-wrapped or bare — same
 * tolerance as `parseTaskResponse` and for the same reason.
 */
export function parseListTasksResponse(raw: unknown): ParsedListTasksResponse | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const envelope = JsonRpcResponseSchema.safeParse(raw);
  if (envelope.success && envelope.data.error) {
    return {
      kind: "error",
      code: envelope.data.error.code,
      message: envelope.data.error.message ?? `JSON-RPC error ${envelope.data.error.code}`,
    };
  }

  const body =
    envelope.success && envelope.data.result && typeof envelope.data.result === "object"
      ? envelope.data.result
      : raw;

  const parsed = ListTasksResultSchema.safeParse(body);
  if (!parsed.success) return null;
  return { kind: "tasks", tasks: parsed.data.tasks ?? [] };
}

// ---------------------------------------------------------------------------
// Part interpretation
// ---------------------------------------------------------------------------

export type NovaosPartExtract = {
  hitlRequest?: { type: "input"; prompt: string; metadata?: Record<string, unknown> };
  /**
   * A connector needs the user to complete an OAuth flow before the run can
   * continue. Under ACP this was its own `connector.oauth_required` event type;
   * A2A has no event vocabulary, so it arrives as a NovaOS metadata part
   * alongside `TASK_STATE_AUTH_REQUIRED`.
   */
  oauthRequest?: { connector: string; authUrl: string; payload: Record<string, unknown> };
  /**
   * A tool call needs explicit user confirmation before it writes. Under ACP
   * this was `tool.write_confirmation_required`; in A2A it is a NovaOS metadata
   * part alongside `TASK_STATE_INPUT_REQUIRED`.
   */
  writeConfirmation?: { callId: string; toolName: string; payload: Record<string, unknown> };
  metadata?: Record<string, unknown>;
};

/**
 * Keys inside a NovaOS metadata part that carry a pause payload.
 *
 * `hitl` is the generic case; `oauth` and `write_confirmation` are NovaOS's
 * chosen A2A carriers for two pause kinds that were ACP event *types* and
 * therefore have no A2A home of their own. The direction is already fixed on
 * the outbound side — the gateway's `a2a-translate.ts` maps
 * `connector.oauth_required` → `AUTH_REQUIRED` and
 * `tool.write_confirmation_required` → `INPUT_REQUIRED` — so this is the same
 * mapping read backwards.
 *
 * ⚠️ **Pinned across the platform boundary.** These three
 * literals are emitted by `novaos-client-sdk`'s `MessageBuilder` —
 * `create_hitl_message`, `create_oauth_required_message`,
 * `create_write_confirmation_required_message` in `message_builder.py`, whose
 * own copies are `NOVAOS_PAUSE_HITL_KEY` / `NOVAOS_PAUSE_OAUTH_KEY` /
 * `NOVAOS_PAUSE_WRITE_CONFIRMATION_KEY`. That is a different repository and
 * language, so no import can enforce parity the way `NOVAOS_METADATA_CONTENT_TYPE`
 * is pinned within a single repo (see that constant's own comment below) —
 * instead each side pins its own literals against the documented contract and
 * this file's `wire.test.ts` exercises the exact wire shape the SDK factories
 * produce. Treat a value changing on either side without the other as a P0.
 *
 * `extractPausePayloads` also recognises the two shapes when they arrive
 * nested inside a `hitl` payload, which is what an agent using only the
 * generic `create_hitl_message` factory (rather than the two dedicated ones
 * above) produces.
 *
 * **The nested-in-`hitl` fallback is a permanent
 * compatibility path, not a temporary shim.** `create_hitl_message` remains a
 * valid, supported factory for its own purpose (a generic prompt or plan
 * confirmation) — it is not deprecated by the two dedicated factories existing
 * — so an agent that embeds `auth_url` or `call_id` inside a `hitl` payload
 * today does not get automatically fixed by a client-sdk version bump; nothing
 * short of a source change to call the dedicated factory removes that shape
 * from the wire. Removing this fallback once the factories exist, as an
 * earlier draft of this decision considered, would silently break every such
 * agent instead. Keep it.
 */
export const NOVAOS_PAUSE_KEYS = {
  HITL: "hitl",
  OAUTH: "oauth",
  WRITE_CONFIRMATION: "write_confirmation",
} as const;

/**
 * Read the vendor content-type off a part's own `metadata`, if any.
 *
 * Shared by `tryExtractNovaosMetadata` (platform metadata) and `drainParts`
 * (the skill-metadata marker) so both read the same field the same way.
 */
function novaosPartContentType(part: InboundPart): unknown {
  const partMetadata = part.metadata;
  return partMetadata && typeof partMetadata === "object"
    ? partMetadata[NOVAOS_METADATA_PART_KEY]
    : undefined;
}

/**
 * Check whether a part carries NovaOS platform metadata and, if so, extract the
 * HITL / error / progress payloads from it.
 *
 * Returns `true` when the part was a metadata part, so the caller knows to skip
 * it for visible content.
 *
 * The A2A shape is materially simpler than ACP's: `DataPart.data` is a real
 * JSON object, where ACP carried a JSON *string* in `content` that had to be
 * parsed and could fail to parse. The vendor content-type moved from the part's
 * own `content_type` field (which A2A parts do not have) to
 * `metadata[NOVAOS_METADATA_PART_KEY]`.
 */
export function tryExtractNovaosMetadata(part: InboundPart, out: NovaosPartExtract): boolean {
  if (novaosPartContentType(part) !== NOVAOS_METADATA_CONTENT_TYPE) return false;

  const record = part.data;
  // A metadata part whose `data` is not an object is still a metadata part —
  // report it as one so the caller suppresses it, but there is nothing to read.
  if (!record || typeof record !== "object" || Array.isArray(record)) return true;

  const hitl = record[NOVAOS_PAUSE_KEYS.HITL];
  if (hitl && typeof hitl === "object" && !Array.isArray(hitl)) {
    const h = hitl as Record<string, unknown>;
    out.hitlRequest = {
      type: "input",
      prompt: firstString(h.content, h.message, h.prompt) ?? "Agent needs input",
      metadata: h,
    };
  }

  extractPausePayloads(record, out);

  out.metadata = { ...(out.metadata ?? {}), ...record };
  return true;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Read the OAuth-required and write-confirmation payloads out of a NovaOS
 * metadata record.
 *
 * Each is looked for in its own key first and then, failing that, *inside* the
 * `hitl` payload by shape — an `auth_url` makes it an OAuth prompt, a `call_id`
 * makes it a write confirmation. The nested form is not a guess for its own
 * sake: `message_builder`'s HITL factory is the only pause carrier the SDK ships
 * today, so an agent that has been migrated to A2A without a dedicated factory
 * has nowhere else to put these. Reading both keeps the two pause kinds working
 * across that gap instead of silently degrading them to a generic HITL prompt,
 * which would drop the connector name the UI needs for its "Connect" button and
 * the `call_id` the write-confirmation claim is bound to.
 *
 * Field names are ACP's unchanged (`connector` / `auth_url`, `call_id` /
 * `tool_name` / `pending_tool`) — only the carrier moved, and keeping the names
 * means the Redis stream payloads the marketplace UI parses do not change shape.
 */
export function extractPausePayloads(
  record: Record<string, unknown>,
  out: NovaosPartExtract
): void {
  const hitl = asRecord(record[NOVAOS_PAUSE_KEYS.HITL]);

  const oauth =
    asRecord(record[NOVAOS_PAUSE_KEYS.OAUTH]) ??
    (hitl && typeof hitl.auth_url === "string" ? hitl : undefined);
  if (oauth) {
    out.oauthRequest = {
      connector: firstString(oauth.connector) ?? "unknown",
      authUrl: firstString(oauth.auth_url, oauth.authUrl) ?? "",
      payload: oauth,
    };
  }

  const writeConfirmation =
    asRecord(record[NOVAOS_PAUSE_KEYS.WRITE_CONFIRMATION]) ??
    (hitl && typeof hitl.call_id === "string" ? hitl : undefined);
  if (writeConfirmation) {
    // `callId` is deliberately allowed to be empty here rather than defaulted:
    // the confirmation claim is bound to it, so the activity must be able to
    // tell "no call_id" apart from a placeholder and fail the run explicitly.
    out.writeConfirmation = {
      callId: firstString(writeConfirmation.call_id, writeConfirmation.callId) ?? "",
      toolName:
        firstString(
          writeConfirmation.tool_name,
          writeConfirmation.toolName,
          writeConfirmation.pending_tool
        ) ?? "",
      payload: writeConfirmation,
    };
  }
}

/**
 * The displayable text of an artifact, in part order.
 *
 * This is the unit the completeness ledger measures: an artifact's recovered
 * length is compared against how much of it was already published, and the
 * difference is the tail that a disconnect swallowed.
 */
export function artifactText(artifact: InboundArtifact): string {
  return (artifact.parts ?? [])
    .filter((part) => isTextPart(part) && part.text)
    .map((part) => part.text as string)
    .join("");
}

/**
 * First non-empty string among the candidates.
 *
 * Every one of these comes off the wire as `unknown`, and a plain
 * `String(a ?? b)` on an object yields `"[object Object]"` — a prompt no user
 * should ever be shown. Non-strings are skipped rather than coerced.
 */
export function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Part draining
// ---------------------------------------------------------------------------

/**
 * Top-level keys inside a *platform-marker* (`NOVAOS_METADATA_CONTENT_TYPE`)
 * `DataPart` that the platform itself reads.
 *
 * Used only for the legacy compatibility path in `drainParts`: an agent
 * built against an SDK from before `NOVAOS_SKILL_METADATA_CONTENT_TYPE`
 * existed still tags its own `SkillResult.metadata` with the platform marker,
 * because that was the only marker `_agent_message` had. This list is how
 * `drainParts` tells "the platform's business" apart from "the skill's own
 * result" inside such a part, so the latter can still reach `data` instead of
 * being silently dropped the way it was before this ticket.
 */
const RESERVED_PLATFORM_METADATA_KEYS = new Set<string>([
  NOVAOS_PAUSE_KEYS.HITL,
  NOVAOS_PAUSE_KEYS.OAUTH,
  NOVAOS_PAUSE_KEYS.WRITE_CONFIRMATION,
  NOVAOS_SKILL_ERROR_KEY,
  "error",
  "progress",
  "tool.call",
  "tool_call",
  "tool.result",
  "tool_result",
]);

/**
 * Pick the non-reserved keys out of a platform-marker part's `data`, for the
 * legacy compatibility path described above.
 *
 * Returns `undefined` when there is nothing to pick — `record` is not a plain
 * object, or every key it carries is one the platform itself reads — so the
 * caller can tell "no legacy skill metadata" apart from "an empty object" with
 * a single truthiness check.
 */
function pickLegacySkillMetadata(record: unknown): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const picked: Record<string, unknown> = {};
  let found = false;
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (RESERVED_PLATFORM_METADATA_KEYS.has(key)) continue;
    picked[key] = value;
    found = true;
  }
  return found ? picked : undefined;
}

/**
 * Split a part list into displayable text and NovaOS platform metadata.
 *
 * Metadata parts never contribute visible text — the same rule the ACP path
 * applied to parts carrying the vendor content-type — and every pause payload
 * they carry is merged into `extract`, which the caller owns and accumulates
 * across the whole task.
 *
 * A part tagged `NOVAOS_SKILL_METADATA_CONTENT_TYPE` is mostly
 * the opposite case: it is a skill's own structured result, folded in from
 * `SkillResult.metadata`, and is treated like an untagged `DataPart` — it
 * contributes to `data`, not to `extract`'s displayable-text suppression.
 * It is *also* read for a pause payload the same way a platform-marker
 * part is, via {@link extractPausePayloads}. This is how `SkillResult(status=
 * "AUTH_REQUIRED", metadata={oauth: {...}})` or `{write_confirmation: {...}}`
 * reaches `extract.oauthRequest` / `extract.writeConfirmation`: the SDK tags
 * `SkillResult.metadata` with this marker (not `NOVAOS_METADATA_CONTENT_TYPE`),
 * so a pause payload placed there was previously invisible to
 * `extractPausePayloads` — the `oauth`/`write_confirmation` key inside it never
 * reached the caller, only the bare A2A task state did. Reading it does not
 * regress the "treated like an untagged DataPart" rule above: the record still
 * goes to `data` in full, pause keys included, exactly as before this ticket.
 * A part still tagged with the older, overloaded `NOVAOS_METADATA_CONTENT_TYPE`
 * marker is read for platform fields as before, but any *other* keys it
 * carries are also picked into `data` (`sawLegacySkillMetadata` reports when
 * this happened) — the compatibility path for an agent pod running an SDK
 * from before the two markers were split apart.
 *
 * `sawProgress` reports whether this batch carried a `progress` payload. A
 * caller uses it to suppress the batch's own text: an agent reporting progress
 * is describing what it is doing, not producing output, and republishing that
 * text as agent content is how a progress line ends up inside a user's answer.
 *
 * `data`, `files` and `filesRejected` describe the parts that are not
 * displayable text, which used to leave here with no record that they existed
 * at all. None of the three is used on the *message* paths
 * — a message's non-text parts have nowhere to go — but an artifact's do, and
 * one drain function serving both is what keeps the metadata rules identical on
 * every path.
 *
 * A file part is *classified* here, not stored: this function is synchronous
 * and pure, and writing bytes is neither. `files` carries the accepted ones
 * with their decoded bytes for the pod-caller to persist; `filesRejected`
 * carries the refusals verbatim, to travel into the payload so the caller
 * learns of them.
 */
export function drainParts(
  parts: InboundPart[] | null | undefined,
  extract: NovaosPartExtract
): {
  texts: string[];
  sawProgress: boolean;
  /**
   * Whether any part carried a skill's own metadata under the older, overloaded
   * platform marker rather than `NOVAOS_SKILL_METADATA_CONTENT_TYPE` — an agent
   * pod running an SDK from before the two were split apart. The data
   * itself is already in `data`; this is only a signal for the caller to log a
   * deprecation warning.
   */
  sawLegacySkillMetadata: boolean;
  /** Non-metadata `DataPart` payloads, in part order. */
  data: Record<string, unknown>[];
  /** `FilePart`s that passed policy, with decoded bytes, in part order. */
  files: ClassifiedArtifactFile[];
  /** `FilePart`s the platform refused, in part order. */
  filesRejected: RunArtifactFileRejection[];
} {
  const texts: string[] = [];
  const data: Record<string, unknown>[] = [];
  const files: ClassifiedArtifactFile[] = [];
  const filesRejected: RunArtifactFileRejection[] = [];
  let sawProgress = false;
  let sawLegacySkillMetadata = false;

  for (const part of parts ?? []) {
    // A skill's own folded-in result: treated like an untagged
    // `DataPart` for text/data purposes, but also checked for a pause payload
    // see the doc comment above for why a plain `SkillResult(status=
    // "AUTH_REQUIRED", metadata={...})` return needs this.
    if (novaosPartContentType(part) === NOVAOS_SKILL_METADATA_CONTENT_TYPE) {
      if (isDataPart(part)) {
        const record = part.data as Record<string, unknown>;
        data.push(record);
        extractPausePayloads(record, extract);
      }
      continue;
    }

    const partExtract: NovaosPartExtract = {};
    if (tryExtractNovaosMetadata(part, partExtract)) {
      if (partExtract.hitlRequest) extract.hitlRequest = partExtract.hitlRequest;
      if (partExtract.oauthRequest) extract.oauthRequest = partExtract.oauthRequest;
      if (partExtract.writeConfirmation) extract.writeConfirmation = partExtract.writeConfirmation;
      if (partExtract.metadata) {
        extract.metadata = { ...(extract.metadata ?? {}), ...partExtract.metadata };
        if (partExtract.metadata.progress != null) sawProgress = true;
      }
      // Compatibility path: a legacy SDK tags a skill's own metadata with
      // this same platform marker, so anything here the platform does not
      // itself read is the skill's result smuggled in under the wrong marker
      // — surface it as data rather than dropping it.
      const legacySkillMetadata = pickLegacySkillMetadata(part.data);
      if (legacySkillMetadata) {
        data.push(legacySkillMetadata);
        sawLegacySkillMetadata = true;
      }
      continue;
    }
    if (isTextPart(part) && part.text) {
      texts.push(part.text);
      continue;
    }
    if (isDataPart(part)) {
      data.push(part.data as Record<string, unknown>);
      continue;
    }
    if (isFilePart(part)) {
      // Beyond the per-frame count the remainder are refused rather than
      // classified: decoding them would materialise bytes this frame has
      // already decided it will not store.
      if (files.length + filesRejected.length >= MAX_ARTIFACT_FILES_PER_FRAME) {
        filesRejected.push({
          reason: "run_allowance_exhausted",
          detail: `This artifact frame already carries ${MAX_ARTIFACT_FILES_PER_FRAME} file parts, the per-frame maximum.`,
        });
        continue;
      }
      const classified = classifyArtifactFilePart(part);
      if (classified.accepted) files.push(classified.accepted);
      else filesRejected.push(classified.rejection);
    }
  }

  return { texts, sawProgress, sawLegacySkillMetadata, data, files, filesRejected };
}

/**
 * Per-artifact content cap, matching the run-wide collected-content cap the
 * two pod-callers apply to `message.final`.
 */
export const MAX_ARTIFACT_CONTENT_BYTES = 10 * 1024 * 1024;

/**
 * Per-artifact cap on serialised `DataPart` payloads.
 *
 * Smaller than the text cap on purpose. A `DataPart` is structured result data,
 * not bulk prose, and unlike text it is stored *in addition* to the same bytes
 * already collected into the run's `content` — so an uncapped one grows the
 * activity result and the `event_index` row on top of everything text already
 * costs.
 */
export const MAX_ARTIFACT_DATA_BYTES = 1024 * 1024;

/**
 * Keep whole `DataPart` payloads while they fit under the cap.
 *
 * Entries are kept or dropped whole: half a JSON object is not a `DataPart` a
 * caller can do anything with, so truncating one the way text is truncated
 * would hand over something strictly worse than nothing. An entry larger than
 * the cap on its own is therefore dropped rather than cut.
 */
function capArtifactData(data: Record<string, unknown>[]): {
  kept: Record<string, unknown>[];
  dropped: boolean;
} {
  const kept: Record<string, unknown>[] = [];
  let used = 0;
  let dropped = false;

  for (const entry of data) {
    const size = JSON.stringify(entry)?.length ?? 0;
    if (used + size > MAX_ARTIFACT_DATA_BYTES) {
      dropped = true;
      continue;
    }
    used += size;
    kept.push(entry);
  }

  return { kept, dropped };
}

/**
 * The id this artifact will be recorded under.
 *
 * Extracted because a pod-caller has to know it *before* recording the frame:
 * an artifact's file bytes are stored under this id so the download route can
 * verify that a URL's `artifactId` and `fileId` belong together, and storage
 * happens before `toRunArtifactPayload` is called. Two
 * derivations of the same id would be a way for the stored row and the payload
 * to disagree, which is a 404 on a URL the platform itself published.
 */
export function resolveArtifactId(artifact: InboundArtifact, fallbackId: string): string {
  return firstString(artifact.artifactId) ?? fallbackId;
}

/**
 * Render one inbound artifact as an `artifact.update` payload.
 *
 * Shared by both of NovaOS's pod-callers — the Temporal worker's
 * `mint-and-execute` activity and the gateway's own adapter — because an
 * artifact must reach `event_index` in the same shape whichever one dispatched
 * the run, or `GetTask` would answer differently depending on the execution
 * path a caller never chose.
 *
 * ## What travels, and what does not
 *
 * - **Text parts** are joined in part order, as they always were.
 * - **Data parts** travel whole, in `data`. An artifact is the task's
 *   machine-readable result and a `DataPart` inside one is the agent author
 *   deliberately publishing structure; dropping it left a JSON-emitting agent
 *   with no way to return JSON at all. This is not the tool-payload rule
 *   in reverse: tool arguments are incidental internals, an artifact is the
 *   declared output.
 * - **File parts travel as references**, in `files`. The
 *   bytes are stored in `run_artifact_files` by the pod-caller before this is
 *   built, and what lands in `event_index` is a `file_id` the gateway turns
 *   into a download URL on its own origin. Neither of the two things that
 *   *cannot* travel does: not the pod's `url`, which is an in-cluster address
 *   the gateway façade exists to withhold, and not inline `raw` bytes, which
 *   would put an unbounded base64 blob in a JSON column every poll reads.
 * - **A file part the platform refuses is reported, not dropped**, in
 *   `files_rejected` — a `url`-only part, one over `MAX_ARTIFACT_FILE_BYTES`,
 *   one the inbound attachment policy would have refused, or one the run's
 *   allowance no longer covers. It reaches the caller through `GetTask`
 *   rather than only a support log, because a rejection the caller cannot see
 *   is indistinguishable from the silent drop this replaced.
 *
 * `artifactId` is required by A2A §6.4 but arrives `nullish` off the wire
 * because this schema trusts nothing; `fallbackId` names the artifact when a
 * pod omits it, so a nameless artifact still becomes a distinguishable entry
 * rather than being merged into whatever else had no id.
 */
export function toRunArtifactPayload(
  artifact: InboundArtifact,
  options: {
    texts: string[];
    data: Record<string, unknown>[];
    fallbackId: string;
    append?: boolean | null;
    lastChunk?: boolean | null;
    /** Already-stored file references, in part order. */
    files?: RunArtifactFileRef[];
    /** File parts the platform refused, in part order. */
    filesRejected?: RunArtifactFileRejection[];
  }
): RunArtifactPayload {
  // Capped for the same reason the run's collected content is: this payload is
  // written to `event_index` as one row, and an agent that emits an unbounded
  // artifact would otherwise take the persistence path with it.
  const joined = options.texts.join("");
  const content =
    joined.length > MAX_ARTIFACT_CONTENT_BYTES
      ? joined.slice(0, MAX_ARTIFACT_CONTENT_BYTES)
      : joined;

  const payload: RunArtifactPayload = {
    artifact_id: resolveArtifactId(artifact, options.fallbackId),
    content,
  };
  if (content.length < joined.length) payload.truncated = true;
  const name = firstString(artifact.name);
  if (name) payload.name = name;
  const description = firstString(artifact.description);
  if (description) payload.description = description;
  if (options.data.length > 0) {
    const { kept, dropped } = capArtifactData(options.data);
    if (kept.length > 0) payload.data = kept;
    if (dropped) payload.data_truncated = true;
  }
  if (options.files?.length) payload.files = options.files;
  if (options.filesRejected?.length) payload.files_rejected = options.filesRejected;
  if (options.append) payload.append = true;
  if (options.lastChunk) payload.last_chunk = true;
  return payload;
}

/** Plain text of a message, in part order, ignoring metadata parts. */
export function messageText(message: InboundMessage | null | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => isTextPart(part) && part.text)
    .map((part) => part.text as string)
    .join("");
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

export interface ParsedSseEvent {
  event: string;
  data: string;
}

/**
 * Every spelling of "blank line" the EventSource spec allows, longest first.
 *
 * An SSE line ends with CRLF, LF **or** a bare CR (spec §9.2.4), so an event
 * boundary is any two of those in a row — which is five distinct byte
 * sequences, not just `\n\n`. The alternation is written out rather than
 * expressed as `(?:\r\n|\r|\n){2}`, because that form backtracks a single
 * `\r\n` into `\r` + `\n` and would cut every event in half at its first line
 * break.
 *
 * This is not hypothetical tolerance. `a2a-sdk` serves its streams through
 * `sse-starlette`, whose `DEFAULT_SEPARATOR` is `\r\n` — so **every** frame
 * from a scaffolded A2A pod is CRLF-delimited and contains no `\n\n` at all.
 */
const SSE_EVENT_BOUNDARY = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/;

/**
 * Split a read buffer into complete SSE event blocks, keeping the tail.
 *
 * The returned `rest` is the incomplete trailing block, to be carried into the
 * next `reader.read()` — including a lone trailing `\r`, which may turn out to
 * be the first byte of a `\r\n\r\n` boundary split across two TCP chunks.
 *
 * Every A2A stream reader must go through this rather than splitting on a
 * literal separator of its own: a reader that picks one spelling silently sees
 * zero events from a server that picked another, and an SSE reader that parses
 * nothing is indistinguishable from a pod that streamed nothing.
 */
export function splitSseEventBlocks(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;

  for (;;) {
    const match = SSE_EVENT_BOUNDARY.exec(rest);
    if (!match) break;
    events.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }

  return { events, rest };
}

/**
 * Parse one SSE event block into its `event` name and its `data` payload.
 *
 * Lines are split on CRLF, LF or a bare CR for the reason above — a block cut
 * out by `splitSseEventBlocks` still carries whichever line terminator the
 * server used *inside* it.
 *
 * Multi-line `data:` is rejoined with newlines per the EventSource spec, which
 * matters here: `a2a-sdk` pretty-prints nothing today, but a `StreamResponse`
 * carrying a long artifact is exactly the frame a server is most likely to emit
 * across several `data:` lines, and a line-at-a-time reader would hand each
 * fragment to `JSON.parse` and drop the frame.
 *
 * Returns `null` for a block that carries no data and no explicit event name —
 * a keep-alive comment or a stray blank block, neither of which is an error.
 */
export function parseSseEvent(raw: string): ParsedSseEvent | null {
  const lines = raw.split(/\r\n|\r|\n/);
  let event = "message";
  let data = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trim();
    }
    // Anything else — a `:` comment, an `id:`, a `retry:` — is not something a
    // NovaOS caller acts on.
  }

  if (!data && event === "message") return null;
  return { event, data };
}

// ---------------------------------------------------------------------------
// Tool events
// ---------------------------------------------------------------------------

/** The two tool event kinds NovaOS surfaces, in the platform's own spelling. */
export type A2AToolEventType = "tool.call" | "tool.result";

export type A2AToolEvent = { type: A2AToolEventType; payload: Record<string, unknown> };

/**
 * Accept either spelling of a tool event key.
 *
 * Agents wrote these both ways under ACP (`tool.call` as an SSE event name,
 * `tool_call` as a payload discriminator), and the migration does not get to
 * pick one for code that already exists in the fleet, so both are read.
 */
function normalizeToolEventType(raw: string): A2AToolEventType | null {
  if (raw === "tool.call" || raw === "tool_call") return "tool.call";
  if (raw === "tool.result" || raw === "tool_result") return "tool.result";
  return null;
}

/** Unwrap a tool event payload that was nested one level under `payload`. */
function extractToolEventPayload(
  parsedData: Record<string, unknown> | null
): Record<string, unknown> {
  if (!parsedData) return {};
  const nested = parsedData.payload;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return parsedData;
}

/**
 * Read `tool.call` / `tool.result` events out of a NovaOS metadata part.
 *
 * **This is where tool auditing moved.** Under ACP, agents surfaced tool events
 * either as bespoke SSE event types (`tool.call`, `tool_result`, …) or as
 * `output[].type` / `part.type` discriminators on the JSON body. A2A has
 * neither: the SSE stream carries only `StreamResponse` frames, and a v1.0
 * `Part` has no `type` field to overload. The one structured extension point
 * left is the NovaOS metadata part that already carries HITL, error and progress
 * payloads, so tool events are read from there — `{"tool.call": {...}}` or
 * `{"tool_call": {...}}` inside the metadata object.
 *
 * Nothing emits that shape yet: it needs the pod-side SDK to put tool events in
 * the metadata part. Not yet wired up on the pod side.
 * Until then this is a correctly-wired no-op rather than a silently dropped
 * capability.
 */
export function collectToolEvents(metadata: Record<string, unknown> | undefined): A2AToolEvent[] {
  const events: A2AToolEvent[] = [];
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const type = normalizeToolEventType(key);
    if (!type) continue;
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    events.push({ type, payload: extractToolEventPayload(raw) });
  }
  return events;
}

/**
 * A pod's memory pre-fetch outcome for this turn.
 * `retrieval_id` is opaque — the Memory Service's
 * own `ExplainRetrieval` lookup key, not something this side interprets.
 */
export type MemoryAssembledEvent = {
  retrieval_id?: string;
  partial?: boolean;
  sources_consulted?: string[];
  sources_skipped?: string[];
};

/**
 * Read the `memory.assembled` platform event out of a NovaOS metadata part,
 * if present.
 *
 * A **sibling** of `collectToolEvents`, not a case folded into it —
 * `memory.assembled` is not a tool event, and widening `A2AToolEventType`'s
 * two-member union to admit it would misroute it into every `collectToolEvents`
 * caller's tool.call/tool.result branches (mislabeling a memory pre-fetch as
 * an unnamed "tool result" in the live UI and audit log, since its payload has
 * no `tool_name`). `novaos-agent-client-sdk`'s `AgentBuilder` emits at most one
 * of these per turn — see `AgentExecutionContext._emit_platform_event`'s own
 * contract — so this returns a single value rather than a list.
 */
export function extractMemoryAssembledEvent(
  metadata: Record<string, unknown> | undefined
): MemoryAssembledEvent | undefined {
  const raw = metadata?.["memory.assembled"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as MemoryAssembledEvent;
}

/**
 * Best-effort tool name for a tool event payload.
 *
 * Falls back to `"unknown"` rather than throwing: a tool event with an
 * unrecognisable name is still worth surfacing to the UI and the audit log, and
 * dropping it would lose the arguments and result alongside the name.
 */
export function resolveToolNameFromPayload(payload: Record<string, unknown>): string {
  return firstString(payload.tool_name, payload.tool, payload.name) ?? "unknown";
}

/** Is this part displayable text? A `oneof` member check, not a tag check. */
export const isTextPart = (part: InboundPart): boolean => typeof part.text === "string";

/** Is this part structured data? Same `oneof` presence test as `isTextPart`. */
export const isDataPart = (part: InboundPart): boolean =>
  !!part.data && typeof part.data === "object" && !Array.isArray(part.data);

/**
 * Is this part a file?
 *
 * v1.0's `FilePart` is a nested oneof — inline bytes (`raw`) or a reference
 * (`url`) — so either field present means "file".
 */
export const isFilePart = (part: InboundPart): boolean =>
  typeof part.raw === "string" || typeof part.url === "string";

// ---------------------------------------------------------------------------
// Artifact file parts
// ---------------------------------------------------------------------------

/**
 * Largest single file part an artifact may carry.
 *
 * **The same number the inbound path enforces**
 * (`DEFAULT_MAX_ATTACHMENT_BYTES`), so a file an agent may *receive* is exactly
 * a file it may *return*. Picking a different bound in each direction would
 * give agent authors two limits to learn and make a round trip — take a file
 * in, hand it back out — fail for no reason a caller could predict.
 */
export const MAX_ARTIFACT_FILE_BYTES = DEFAULT_MAX_ATTACHMENT_BYTES;

/**
 * Total file bytes one run may store, across every artifact and every frame.
 *
 * The per-file bound above stops one huge file; this stops many small ones. A
 * pod streaming an artifact as `append` frames, each with its own small file
 * part, stays under `MAX_ARTIFACT_FILE_BYTES` indefinitely — the same hole the
 * text and data caps needed a run-wide bound to close.
 *
 * Five files at the per-file maximum — deliberately below the inbound ceiling
 * (`DEFAULT_MAX_ATTACHMENTS_PER_REQUEST` files at
 * `DEFAULT_MAX_ATTACHMENT_BYTES` each). Inbound bounds a *request* a human or
 * caller composed; this bounds what an agent can decide to emit on its own, and
 * being the more generous of the two is the wrong side of that asymmetry to err
 * on.
 */
export const MAX_ARTIFACT_FILES_BYTES_PER_RUN = 5 * MAX_ARTIFACT_FILE_BYTES;

/** File parts one artifact frame may store. Beyond this the rest are rejected. */
export const MAX_ARTIFACT_FILES_PER_FRAME = DEFAULT_MAX_ATTACHMENTS_PER_REQUEST;

/**
 * A file part that passed policy, with its decoded bytes, awaiting storage.
 *
 * Held only for as long as it takes the pod-caller to write it to
 * `run_artifact_files`; the bytes never enter a `RunArtifactPayload`, never
 * cross a Temporal activity boundary (the 4 MB gRPC limit is why the inbound
 * path offloads at all), and never reach `event_index`.
 */
export type ClassifiedArtifactFile = {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
};

/** What {@link classifyArtifactFilePart} decided about one file part. */
export type ArtifactFileClassification =
  | { accepted: ClassifiedArtifactFile; rejection?: undefined }
  | { accepted?: undefined; rejection: RunArtifactFileRejection };

/**
 * Where a pod-caller sends an artifact's accepted file bytes.
 *
 * An interface rather than a concrete store because the two pod-callers reach
 * storage differently: the Temporal worker's activities hold a Prisma client
 * directly, while `a2a-adapter` is a pure A2A↔`RunEvent` translator with no
 * database of its own and is handed one by the gateway that constructs it.
 * Keeping the seam here also keeps this module free of Prisma, so an adapter
 * importing this shared a2a module does not acquire a database
 * dependency.
 *
 * One `store` call is one artifact frame. It returns a reference per file it
 * persisted and a rejection per file it did not, both in part order, so the
 * caller can hand them straight to `toRunArtifactPayload` without re-deriving
 * which was which.
 *
 * **A store that cannot write must reject, not throw.** A run whose text and
 * data parts are complete is not a failed run because a file could not be
 * saved; `storage_unavailable` in `files_rejected` tells the caller exactly
 * that, and the run settles as it otherwise would.
 */
export interface ArtifactFileSink {
  store(
    artifactId: string,
    files: ClassifiedArtifactFile[]
  ): Promise<{ refs: RunArtifactFileRef[]; rejected: RunArtifactFileRejection[] }>;
}

/**
 * A sink for a caller with nowhere to put bytes — every file is refused.
 *
 * The default wherever a store is optional, so "no store configured" produces
 * the same visible, in-band `storage_unavailable` rejection as a store that
 * failed, rather than the silent drop this ticket removed.
 */
export const REJECTING_ARTIFACT_FILE_SINK: ArtifactFileSink = {
  store: async (_artifactId, files) => ({
    refs: [],
    rejected: files.map((file) => ({
      filename: file.filename,
      media_type: file.mediaType,
      size_bytes: file.bytes.byteLength,
      reason: "storage_unavailable" as const,
      detail: "No artifact file store is configured for this execution path.",
    })),
  }),
};

/**
 * Decide whether one file part may be stored, and refuse it explicitly if not.
 *
 * ## `url` is never followed
 *
 * A `url`-only file part names an address the *pod* chose. Fetching it would be
 * SSRF against whatever the pod pointed at — which is precisely why
 * `rehydrateAttachments` in the Temporal worker refuses to fetch any inbound
 * attachment the gateway did not itself tag `_offloaded`. Forwarding it
 * untouched is no better: the gateway façade exists to keep in-cluster addresses
 * out of an external caller's hands, and an artifact is exactly the field a
 * caller would follow. So a `url` part is rejected, in-band, with the reason —
 * an agent that wants a file to travel inlines it as `raw`.
 *
 * ## Inline bytes go through the *inbound* attachment policy
 *
 * Not a parallel ruleset: `validateChatAttachment` is the same function
 * `enforceAttachmentPolicy` calls on the way in, so the MIME allowlist, the
 * executable denylist, filename-traversal safety and the magic-byte sniff are
 * one decision applied in both directions. An artifact file the platform would
 * have refused to accept is an artifact file it refuses to serve.
 *
 * The size check is made here rather than left to `validateChatAttachment` for
 * two reasons: the base64 length is tested *before* decoding, so an oversized
 * part is never materialised into a Buffer, and `too_large` stays
 * distinguishable from `rejected_by_policy` in what the caller is told.
 *
 * ## `undecodable` is a real outcome, and an empty *accepted* file is too
 *
 * The `undecodable` branch below relies on `decodeAttachmentData` actually
 * reporting failure, which for a long time it could not: Node's base64 decoder
 * drops unreadable characters rather than throwing, so garbage `raw` decoded to
 * a short buffer or to nothing and this function accepted it. Under any
 * allowlisted text type the result was a stored, published `FilePart` URL
 * holding nothing, indistinguishable from a real file until downloaded — the
 * silent failure that artifact file storage exists to remove. The validation now lives in
 * `decodeAttachmentData`, where all three of its callers get it.
 *
 * With that closed, a **zero-byte accepted file is deliberately still stored.**
 * The only remaining way to reach one is a pod that explicitly sent no bytes
 * under a text media type, which is the same blank document
 * `enforceAttachmentPolicy` accepts inbound; refusing it here would break the
 * one-policy-both-directions property this function is built on, and would cost
 * the public rejection union an eighth reason that tells a caller nothing it did
 * not already know from `size_bytes: 0`.
 */
export function classifyArtifactFilePart(part: InboundPart): ArtifactFileClassification {
  const declaredName = firstString(part.filename);
  const declaredType = firstString(part.mediaType);

  if (typeof part.raw !== "string") {
    return {
      rejection: {
        ...(declaredName ? { filename: declaredName } : {}),
        ...(declaredType ? { media_type: declaredType } : {}),
        reason: "url_reference_not_supported",
        detail:
          "A file part must carry inline bytes in `raw`. The platform does not " +
          "fetch or forward a `url` an agent chose, and cannot serve one to an " +
          "external caller.",
      },
    };
  }

  // Estimated from the base64 length so an oversized part is refused before it
  // is decoded. 3 bytes per 4 characters, ignoring padding — an over-estimate
  // by at most 2 bytes, which cannot flip a decision at these magnitudes.
  const base64 = part.raw.includes(",") ? (part.raw.split(",")[1] ?? "") : part.raw;
  const estimatedBytes = Math.ceil((base64.length * 3) / 4);
  if (estimatedBytes > MAX_ARTIFACT_FILE_BYTES) {
    return {
      rejection: {
        ...(declaredName ? { filename: declaredName } : {}),
        ...(declaredType ? { media_type: declaredType } : {}),
        size_bytes: estimatedBytes,
        reason: "too_large",
        detail: `File exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte per-file artifact limit.`,
      },
    };
  }

  const bytes = decodeAttachmentData(base64);
  if (!bytes) {
    return {
      rejection: {
        ...(declaredName ? { filename: declaredName } : {}),
        ...(declaredType ? { media_type: declaredType } : {}),
        reason: "undecodable",
        detail: "`raw` is not decodable base64.",
      },
    };
  }

  // Required, not defaulted. The download route serves these bytes under this
  // exact `Content-Type`, and `application/octet-stream` is not on the platform's
  // allowlist — so a defaulted type would refuse every undeclared file anyway,
  // as `rejected_by_policy`, which sends the agent author looking at their
  // content instead of at the one field they left unset. A2A's `FilePart` has
  // `mediaType` precisely so the producer declares it; guessing one from the
  // filename would have the platform vouch for a type nobody asserted.
  if (!declaredType) {
    return {
      rejection: {
        ...(declaredName ? { filename: declaredName } : {}),
        reason: "media_type_required",
        detail:
          "A file part must declare `mediaType`. The platform serves the file " +
          "under that type and will not infer one.",
      },
    };
  }

  const mediaType = declaredType;
  const validated = validateChatAttachment({
    filename: resolveAttachmentFilename(declaredName, mediaType),
    mimeType: mediaType,
    bytes,
    maxBytes: MAX_ARTIFACT_FILE_BYTES,
  });
  if (!validated.ok) {
    return {
      rejection: {
        ...(declaredName ? { filename: declaredName } : {}),
        media_type: mediaType,
        size_bytes: bytes.byteLength,
        reason:
          validated.failure.code === "ATTACHMENT_TOO_LARGE" ? "too_large" : "rejected_by_policy",
        detail: validated.failure.message,
      },
    };
  }

  return {
    accepted: { filename: validated.safeName, mediaType: validated.mimeType, bytes },
  };
}

/**
 * How many artifact frames one run's *in-memory* record may hold.
 *
 * Deliberately the same number as the read side's
 * `MAX_PROJECTED_ARTIFACT_EVENTS`: there is no point recording more frames than
 * the projection will ever read back, and no reason to record fewer. The byte
 * bound below is the one meant to bind in practice; this is the backstop
 * against a pod that chunks an artifact token-by-token.
 */
export const MAX_RECORDED_ARTIFACT_EVENTS = 10_000;

/**
 * Total size one run's recorded artifacts may reach, across every frame.
 *
 * The per-artifact caps above bound one frame; a pod streaming an artifact as
 * thousands of `append` frames stays under every one of them and still grows
 * the total without limit. This is the bound on the sum.
 *
 * **Equal to `MAX_ARTIFACT_CONTENT_BYTES` on purpose, not by coincidence.** A
 * run's artifacts are the same bytes as its collected text, kept apart instead
 * of concatenated, so the record may grow to exactly what the text may. Setting
 * it lower — it was 1 MB against a 10 MB text cap — meant a single artifact that
 * `toRunArtifactPayload` had just accepted could be rejected by the recorder,
 * leaving the record empty and sending `GetTask` back to the run-id blob. That
 * is the defect this event type exists to fix, reintroduced by its own guard.
 */
export const MAX_RECORDED_ARTIFACT_BYTES = MAX_ARTIFACT_CONTENT_BYTES;

export type ArtifactRecorder = {
  /** Record one artifact frame, unless a bound has already been reached. */
  record(
    artifact: InboundArtifact,
    options: {
      texts: string[];
      data: Record<string, unknown>[];
      append?: boolean | null;
      lastChunk?: boolean | null;
      files?: RunArtifactFileRef[];
      filesRejected?: RunArtifactFileRejection[];
    }
  ): void;
  /**
   * The id the *next* `record` call would use for this artifact.
   *
   * Read-only — it consumes nothing, so calling it and then recording yields
   * the same id. A caller needs it to store the artifact's file bytes under the
   * id its payload will carry; deriving the fallback
   * `<runId>:<n>` a second time at the call site is exactly the duplication
   * that would let the two drift.
   */
  nextArtifactId(artifact: InboundArtifact): string;
  /** The recorded frames, or `undefined` when the run produced no artifacts. */
  values(): RunArtifactPayload[] | undefined;
};

/**
 * Accumulate a run's artifact frames under a bound.
 *
 * Needed because a caller that *collects* artifacts rather than streaming them
 * out one at a time — `mint-and-execute`, whose `ExecuteResult` crosses a
 * Temporal activity boundary — holds every frame at once. An unbounded `data`
 * payload or a long `append` stream would grow that value without limit and
 * fail a run that used to complete, on the 4 MB gRPC limit if nothing else.
 *
 * File *bytes* never enter this record for the same reason — only the
 * `file_id` references the pod-caller got back from storage do,
 * which is why the bytes are written before a frame is recorded
 * rather than carried along with it.
 *
 * **Reaching a bound degrades the structure, never the run.** Recording stops
 * and `onCap` fires once; the run's text is untouched, so a caller still gets
 * the complete output through `content` / `output` and loses only the
 * per-artifact breakdown of its tail. Failing the run to protect a projection
 * would be a worse trade than the one this exists to prevent.
 *
 * `runId` names an artifact the pod left unnamed, so those stay distinguishable
 * rather than collapsing into one — the defect this whole event type exists to
 * fix.
 */
export function createArtifactRecorder(
  runId: string,
  onCap?: (reason: "events" | "bytes") => void
): ArtifactRecorder {
  const recorded: RunArtifactPayload[] = [];
  let used = 0;
  let capped = false;

  const reachCap = (reason: "events" | "bytes"): void => {
    capped = true;
    onCap?.(reason);
  };

  const fallbackFor = (): string => `${runId}:${recorded.length + 1}`;

  return {
    nextArtifactId: (artifact) => resolveArtifactId(artifact, fallbackFor()),
    record(artifact, options) {
      if (capped) return;
      if (recorded.length >= MAX_RECORDED_ARTIFACT_EVENTS) return reachCap("events");

      const payload = toRunArtifactPayload(artifact, {
        ...options,
        fallbackId: fallbackFor(),
      });

      const size =
        payload.content.length + (payload.data ? JSON.stringify(payload.data).length : 0);

      // The first artifact is recorded whatever its size. It is already bounded
      // by the per-artifact caps, and a maximal one legitimately exceeds the
      // aggregate budget on its own (10 MB of text plus up to 1 MB of data).
      // Rejecting it would leave the record empty and hand `GetTask` back the
      // run-id blob — a worse answer than the one artifact it was protecting
      // against. The budget governs how far the *rest* of the stream may go.
      if (recorded.length > 0 && used + size > MAX_RECORDED_ARTIFACT_BYTES) {
        return reachCap("bytes");
      }

      used += size;
      recorded.push(payload);
    },
    values: () => (recorded.length > 0 ? recorded : undefined),
  };
}
