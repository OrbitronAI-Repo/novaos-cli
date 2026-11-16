/**
 * Reads the pinned `in_run_check` block from an agent's raw catalog manifest.
 *
 * Like `manifestDeclaresMemory`, it tolerates any shape: the manifest comes out
 * of JSONB without a schema. A block that is not a complete pinned declaration
 * reads as "no check declared" — publish is where an incomplete block is
 * refused, so what reaches a run is either whole or absent.
 */

import { z } from "zod";

import type { PinnedCheckDeclaration } from "./check-config-resolver.js";

const PinnedRubricSchema = z.object({
  ref: z.string().regex(/^[a-z0-9_-]+\/[a-z0-9_]+@[1-9][0-9]*$/),
  threshold: z.number().optional(),
});

const PinnedCheckDeclarationSchema = z.object({
  judge_model: z.string().min(1),
  threshold: z.number().optional(),
  max_refinements: z.number().int().nonnegative().optional(),
  budget_ms: z.number().int().positive().optional(),
  deterministic: z.array(z.string()).optional(),
  regulated_outputs: z.array(z.string()).optional(),
  rubrics: z.array(PinnedRubricSchema).min(1),
});

export function checkDeclarationFromManifest(
  manifest: unknown
): PinnedCheckDeclaration | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const parsed = PinnedCheckDeclarationSchema.safeParse(
    (manifest as { in_run_check?: unknown }).in_run_check
  );
  return parsed.success ? parsed.data : undefined;
}
