/**
 * Builds the `in_run_check` a run carries from the check an agent declared at
 * publish. The declaration holds only pinned rubric references; the rubric
 * texts and their default bars come from a {@link RubricSource} at run time,
 * so a published rubric reaches the next run without rebuilding the agent.
 *
 * The source is a port: the rubric store, the prompt registry or a test fake
 * can sit behind it.
 */

import { resolveRubricBar, type ResolvedCheckConfig } from "./check-config.js";

export interface PinnedRubricDeclaration {
  /** `publisher/name@version`; a bare name or an unpinned reference is rejected. */
  ref: string;
  threshold?: number;
}

/** The agent's declared check after publish: every rubric pinned to a version. */
export interface PinnedCheckDeclaration {
  judge_model: string;
  threshold?: number;
  max_refinements?: number;
  budget_ms?: number;
  deterministic?: string[];
  regulated_outputs?: string[];
  rubrics: PinnedRubricDeclaration[];
}

export interface RubricContent {
  text: string;
  defaultThreshold: number;
  /** The judge model the version was calibrated with, when the platform recorded one. */
  calibratedModel?: string;
}

export interface RubricSource {
  get(id: string, version: number): Promise<RubricContent | undefined>;
}

export class CheckConfigUnresolvableError extends Error {
  constructor(reason: string) {
    super(`check configuration cannot be resolved: ${reason}`);
    this.name = "CheckConfigUnresolvableError";
  }
}

const RUBRIC_REF = /^([a-z0-9_-]+\/[a-z0-9_]+)@([1-9][0-9]*)$/;

export function parseRubricRef(ref: string): { id: string; version: number } | undefined {
  const match = RUBRIC_REF.exec(ref);
  return match ? { id: match[1]!, version: Number(match[2]) } : undefined;
}

/** Fails closed: a rubric that cannot be found stops the configuration, so a
 *  run is never judged against fewer rubrics than the agent declared. */
export async function resolveCheckConfig(
  declaration: PinnedCheckDeclaration,
  source: RubricSource
): Promise<ResolvedCheckConfig> {
  if (declaration.rubrics.length === 0) {
    throw new CheckConfigUnresolvableError("no rubrics declared");
  }
  const rubrics = await Promise.all(
    declaration.rubrics.map(async (entry) => {
      const parsed = parseRubricRef(entry.ref);
      if (!parsed) throw new CheckConfigUnresolvableError(`"${entry.ref}" is not pinned`);
      const content = await source.get(parsed.id, parsed.version);
      if (!content) throw new CheckConfigUnresolvableError(`${entry.ref} was not found`);
      // A calibration holds only for the model that produced it, so another judge is refused here too.
      if (
        content.calibratedModel !== undefined &&
        content.calibratedModel !== declaration.judge_model
      ) {
        throw new CheckConfigUnresolvableError(
          `${entry.ref} was calibrated with "${content.calibratedModel}", not "${declaration.judge_model}"`
        );
      }
      return {
        id: parsed.id,
        version: parsed.version,
        text: content.text,
        threshold: resolveRubricBar({
          rubricDefault: content.defaultThreshold,
          overall: declaration.threshold,
          perRubric: entry.threshold,
        }),
      };
    })
  );
  return {
    judge_model: declaration.judge_model,
    rubrics,
    ...(declaration.max_refinements !== undefined && {
      max_refinements: declaration.max_refinements,
    }),
    ...(declaration.budget_ms !== undefined && { budget_ms: declaration.budget_ms }),
    ...(declaration.deterministic && { deterministic: declaration.deterministic }),
    ...(declaration.regulated_outputs && { regulated_outputs: declaration.regulated_outputs }),
  };
}
