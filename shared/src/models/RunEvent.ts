/**
 * RunEvent model
 * Represents an execution event
 */

import { z } from "zod";

/**
 * Event type enum.
 *
 * `hitl.request` and `hitl` are two independent, live pause vocabularies, not
 * a typo of one another. The A2A adapter path builds its pause event through
 * `createRunEvent`, which validates against this schema, and always uses
 * `hitl.request`. The Temporal workflow path persists its pause with a raw
 * Prisma insert that bypasses this schema entirely, and always uses `hitl` —
 * a string two gateway routes already filter on directly, so it cannot be
 * renamed without breaking them.
 * Both must stay listed here so `EventStore.getByRunId`'s `RunEventSchema.parse`
 * accepts whichever vocabulary a given run's rows actually used.
 */
export const RunEventType = z.enum([
  "status",
  "message.delta",
  "message.final",
  "tool.call",
  "tool.result",
  "hitl.request",
  "hitl",
  "tool.write_confirmation_required",
  "artifact.update",
  "error",
  // A successful memory pre-fetch, surfaced by the gateway's A2A adapter for
  // the action audit. Audit-only: not persisted to the event store, not
  // republished to live clients — the same treatment the Temporal worker
  // gives it.
  "memory.assembled",
]);

export type RunEventType = z.infer<typeof RunEventType>;

/**
 * Payload of an `artifact.update` event.
 *
 * One artifact the agent produced, with the identity the agent gave it
 * Before this event existed, every artifact was drained to
 * text and emitted as `message.delta`, so a run that produced a `report` and a
 * `chart` artifact came back out of `GetTask` as a single artifact named after
 * the run id with both texts concatenated — the caller could no longer tell
 * which bytes were which, which is the whole point of `artifact_id`.
 *
 * Keys are snake_case like every other run-event payload, not the wire's
 * camelCase, so a support engineer greps `artifact_id` the same way they grep
 * `tool_name` or `a2a_task_id`.
 *
 * `append` carries A2A v1.0 §6.4's chunking rule through to the projection: a
 * pod streaming a large artifact sends the tail with `append: true`, and a
 * reader must concatenate those onto the artifact of the same id rather than
 * treating each frame as a separate artifact. An event without it *replaces*
 * what earlier events of that id carried.
 */
/**
 * One of an artifact's file parts, as the run record carries it.
 *
 * **The bytes are not here.** They live in `run_artifact_files`, and this is the
 * handle the gateway turns into a platform-owned download URL. That split is
 * the whole point of storing files separately: an `artifact.update` payload is a
 * Postgres JSON column that every poll of `GET /service/runs/:id` reads, so a
 * base64 blob in it would make the polling endpoint pay for the file on every
 * request. A row in its own table, fetched only when a caller actually asks for
 * the file, costs the poll nothing.
 *
 * `size_bytes` is the decoded length, so a caller can decide whether to fetch
 * before fetching.
 */
export interface RunArtifactFileRef {
  /** Primary key of the stored blob — the last path segment of its download URL. */
  file_id: string;
  /** The agent's own `filename`, when it set one. */
  filename?: string;
  /** The agent's own `mediaType`, or `application/octet-stream` when it set none. */
  media_type: string;
  /** Decoded size of the stored bytes. */
  size_bytes: number;
}

/** Why a file part the agent attached did not become a {@link RunArtifactFileRef}. */
export type RunArtifactFileRejectionReason =
  /** A `url`-only file part: the platform will not fetch a pod-chosen address. */
  | "url_reference_not_supported"
  /** The file part declared no `mediaType`, so there is no type to serve it as. */
  | "media_type_required"
  /** Inline bytes over `MAX_ARTIFACT_FILE_BYTES`. */
  | "too_large"
  /** `raw` was not decodable base64. */
  | "undecodable"
  /** Content type, filename or magic bytes failed the attachment policy. */
  | "rejected_by_policy"
  /** The run had already stored its per-run byte or per-artifact count allowance. */
  | "run_allowance_exhausted"
  /** No blob store was reachable, so the bytes could not be persisted. */
  | "storage_unavailable";

/**
 * A file part the agent attached and the platform refused, reported in-band.
 *
 * **Deliberately part of the caller's answer, not only a log line.** Logging a
 * dropped file part without telling the caller means an agent author watching `GetTask` could not tell "the file did
 * not travel" from "the agent never attached one". A rejection a support
 * engineer can see and the caller cannot is still a silent drop from where it
 * matters.
 *
 * The run itself is untouched — see `MAX_RECORDED_ARTIFACT_BYTES` in
 * the shared a2a module for why degrading the projection beats
 * failing a run whose work has already happened.
 */
export interface RunArtifactFileRejection {
  /** The agent's own `filename`, when it set one. */
  filename?: string;
  /** The agent's own `mediaType`, when it set one. */
  media_type?: string;
  /** Decoded size, when it was knowable — absent for a `url`-only part. */
  size_bytes?: number;
  reason: RunArtifactFileRejectionReason;
  /** Human-readable detail, safe to show a caller. Never a raw exception. */
  detail?: string;
}

export interface RunArtifactPayload {
  /** The agent's own `artifactId`, or a synthesised one when the pod omits it. */
  artifact_id: string;
  /** The agent's own artifact name, when it set one. */
  name?: string;
  /** The agent's own artifact description, when it set one. */
  description?: string;
  /** This event's text parts, joined in part order. */
  content: string;
  /** This event's structured (`DataPart`) parts, in part order. */
  data?: Record<string, unknown>[];
  /** True when this event extends the artifact of the same id rather than replacing it. */
  append?: boolean;
  /** True when the pod flagged this as the artifact's last chunk. */
  last_chunk?: boolean;
  /** True when `content` was cut at the size cap rather than ending there. */
  truncated?: boolean;
  /** True when some `data` entries were dropped at the size cap. */
  data_truncated?: boolean;
  /** This event's stored file parts, in part order. */
  files?: RunArtifactFileRef[];
  /** This event's file parts the platform refused, in part order. */
  files_rejected?: RunArtifactFileRejection[];
}

export interface ToolWriteConfirmationPayload {
  call_id: string;
  tool_name: string;
  operation_summary: string;
  proposed_arguments: Record<string, unknown>;
  capability: "write" | "read_write";
}

// RunEvent schema (for Event Store)
export const RunEventSchema = z.object({
  event_id: z.string().uuid(),
  run_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: RunEventType,
  payload: z.record(z.unknown()), // Event payload (JSON)
  schema_version: z.string().default("1.0"),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  timestamp: z.date(),
  storage_path: z.string().optional(), // Path in Cloud Storage if stored externally
});

export type RunEvent = z.infer<typeof RunEventSchema>;

// Create RunEvent input schema
export const CreateRunEventSchema = z.object({
  run_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: RunEventType,
  payload: z.record(z.unknown()),
  schema_version: z.string().default("1.0"),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  storage_path: z.string().optional(),
});

export type CreateRunEventInput = z.infer<typeof CreateRunEventSchema>;

/**
 * Input for createRunEvent: type, payload, run_id, sequence; optional trace_id, span_id, schema_version.
 */
export type CreateRunEventOptions = CreateRunEventInput;

/**
 * Create a RunEvent with generated event_id and timestamp.
 * Use from adapters (ACP, REST) so schema and defaults live in one place.
 */
export function createRunEvent(input: CreateRunEventOptions): RunEvent {
  return RunEventSchema.parse({
    event_id: crypto.randomUUID(),
    run_id: input.run_id,
    sequence: input.sequence,
    type: input.type,
    payload: input.payload,
    schema_version: input.schema_version ?? "1.0",
    trace_id: input.trace_id,
    span_id: input.span_id,
    timestamp: new Date(),
    storage_path: input.storage_path,
  });
}
