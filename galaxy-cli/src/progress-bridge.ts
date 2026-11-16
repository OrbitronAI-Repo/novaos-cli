/**
 * The `progress_bridge` block of an agent manifest: how the platform drives an agent that still
 * starts a job with one skill and polls it with another.
 *
 * This is the author's early copy of the publish check, so a faulty block fails on the author's
 * machine instead of at publish. The server runs the same check when it publishes the manifest and
 * stays the authority: this copy must never be stricter or looser than it. Each refusal names the
 * field and never the value written there.
 */

import { z } from "zod";

export const BRIDGE_MIN_POLL_SECONDS = 5;
export const BRIDGE_MAX_POLL_SECONDS = 3600;

export const BRIDGE_REFUSAL_CODES = [
  "block_invalid",
  "date_to_move_required",
  "date_to_move_invalid",
  "date_to_move_past",
  "poll_interval_invalid",
  "skills_not_distinct",
  "skill_unknown",
  "status_mapping_invalid",
  "status_mapping_overlap",
] as const;
export type BridgeRefusalCode = (typeof BRIDGE_REFUSAL_CODES)[number];

export interface BridgeRefusal {
  code: BridgeRefusalCode;
  /** Dotted path of the field, for example `progress_bridge.date_to_move`. */
  path: string;
}

/** One line an author can act on, per refusal code. */
export const BRIDGE_REFUSAL_MESSAGES: Record<BridgeRefusalCode, string> = {
  block_invalid: "progress_bridge is not a valid block (check the field names and types)",
  date_to_move_required:
    "date_to_move is required: the day the agent is expected to move off the bridge",
  date_to_move_invalid: "date_to_move must be a real calendar date written YYYY-MM-DD",
  date_to_move_past: "date_to_move is before today",
  poll_interval_invalid: `poll_interval_seconds must be a whole number from ${BRIDGE_MIN_POLL_SECONDS} to ${BRIDGE_MAX_POLL_SECONDS}`,
  skills_not_distinct: "start_skill, check_skill and cancel_skill must be three different skills",
  skill_unknown: "the skill is not listed in the manifest's skills",
  status_mapping_invalid:
    "status_mapping needs non-empty running, completed and failed lists of statuses, and no other keys",
  status_mapping_overlap: "a status may appear in only one of running, completed and failed",
};

const skillName = z.string().min(1).max(255);
const statuses = z.array(z.string().min(1).max(255));

const ProgressBridgeSchema = z
  .object({
    start_skill: skillName,
    check_skill: skillName,
    cancel_skill: skillName.optional(),
    poll_interval_seconds: z
      .number()
      .int()
      .min(BRIDGE_MIN_POLL_SECONDS)
      .max(BRIDGE_MAX_POLL_SECONDS),
    status_mapping: z
      .object({ running: statuses.min(1), completed: statuses.min(1), failed: statuses.min(1) })
      .strict(),
    date_to_move: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const PREFIX = "progress_bridge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function refuse(code: BridgeRefusalCode, field?: string): BridgeRefusal {
  return { code, path: field ? `${PREFIX}.${field}` : PREFIX };
}

function shapeRefusals(raw: Record<string, unknown>): BridgeRefusal[] {
  const parsed = ProgressBridgeSchema.safeParse(raw);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const field = issue.path.join(".");
    const head = String(issue.path[0] ?? "");
    if (head === "date_to_move") {
      return refuse(
        raw["date_to_move"] === undefined ? "date_to_move_required" : "date_to_move_invalid",
        "date_to_move"
      );
    }
    if (head === "poll_interval_seconds") return refuse("poll_interval_invalid", head);
    if (head === "status_mapping") return refuse("status_mapping_invalid", field);
    return refuse("block_invalid", field || undefined);
  });
}

/**
 * Every reason the block of this manifest would be refused; empty when the block is whole or
 * absent. `now` is passed in so the date rule reads no clock of its own.
 */
export function checkProgressBridge(manifest: Record<string, unknown>, now: Date): BridgeRefusal[] {
  const raw = manifest[PREFIX];
  if (raw === undefined) return [];
  if (!isRecord(raw)) return [refuse("block_invalid")];

  const refusals = shapeRefusals(raw);
  if (refusals.length > 0) return refusals;

  const declaration = ProgressBridgeSchema.parse(raw);

  if (!isRealDate(declaration.date_to_move)) {
    refusals.push(refuse("date_to_move_invalid", "date_to_move"));
  } else if (declaration.date_to_move < isoDay(now)) {
    refusals.push(refuse("date_to_move_past", "date_to_move"));
  }

  const roles: [string, string | undefined][] = [
    ["start_skill", declaration.start_skill],
    ["check_skill", declaration.check_skill],
    ["cancel_skill", declaration.cancel_skill],
  ];
  const named = roles.filter((r): r is [string, string] => r[1] !== undefined);
  const seen = new Set<string>();
  for (const [field, name] of named) {
    if (seen.has(name)) refusals.push(refuse("skills_not_distinct", field));
    seen.add(name);
  }

  const listed = Array.isArray(manifest["skills"])
    ? (manifest["skills"] as unknown[]).flatMap((s) =>
        isRecord(s) && typeof s["name"] === "string" ? [s["name"]] : []
      )
    : null;
  if (listed !== null && listed.length > 0) {
    for (const [field, name] of named) {
      if (!listed.includes(name)) refusals.push(refuse("skill_unknown", field));
    }
  }

  const { running, completed, failed } = declaration.status_mapping;
  const all = [...running, ...completed, ...failed];
  if (new Set(all).size !== all.length) {
    refusals.push(refuse("status_mapping_overlap", "status_mapping"));
  }

  return refusals;
}
