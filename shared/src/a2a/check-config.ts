/**
 * `in_run_check` in the `novaos.platform/context` — the resolved configuration
 * for the SDK's in-run quality check: which judge model to call, which rubric
 * texts to judge against, and the bar each must meet.
 *
 * Everything here is already resolved by the platform. The agent pod reads it
 * from the context and nothing else: no environment variable or skill argument
 * can add to or change it, and rubric texts travel with the run rather than
 * being baked into the agent image, so publishing a new rubric version changes
 * the next run without a rebuild.
 */

import { z } from "zod";

export const ResolvedRubricSchema = z.object({
  /** `publisher/name`, e.g. `novaos/relevance`. */
  id: z.string().min(1),
  version: z.number().int().positive(),
  text: z.string().min(1),
  /** The bar this rubric must meet, already raised by every applicable floor. */
  threshold: z.number(),
});

export const ResolvedCheckConfigSchema = z.object({
  judge_model: z.string().min(1),
  rubrics: z.array(ResolvedRubricSchema).min(1),
  max_refinements: z.number().int().nonnegative().optional(),
  budget_ms: z.number().int().positive().optional(),
  deterministic: z.array(z.string()).optional(),
  regulated_outputs: z.array(z.string()).optional(),
});

export type ResolvedRubric = z.infer<typeof ResolvedRubricSchema>;
export type ResolvedCheckConfig = z.infer<typeof ResolvedCheckConfigSchema>;

export interface RubricBarInputs {
  /** The default declared in the rubric itself. */
  rubricDefault: number;
  /** The agent's overall threshold, applied to every rubric. */
  overall?: number;
  /** A threshold set for this rubric alone in the agent's declaration. */
  perRubric?: number;
}

/** The bar a rubric must meet: the highest of its default, the overall
 *  threshold and its own per-rubric value. Floors only ever raise the bar. */
export function resolveRubricBar({ rubricDefault, overall, perRubric }: RubricBarInputs): number {
  return Math.max(rubricDefault, overall ?? rubricDefault, perRubric ?? rubricDefault);
}
