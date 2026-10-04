/**
 * Shared Zod schemas for the ADR F6 soft-unbind command's upstream response
 * contracts (app-ops catalog deprecate, agent-ops OrgSubscription deactivate,
 * marketplace SA tombstone).
 *
 * `novaos app unbind` (galaxy-cli) MUST validate these responses through
 * these schemas so a producer-side field rename/removal fails loudly at the
 * CLI boundary instead of silently corrupting the unbind audit trail.
 */

import { z } from "zod";

export const CatalogDeprecateResponseSchema = z.object({
  status: z.string().optional(),
});

export const OrgSubscriptionDeactivateResponseSchema = z.object({
  data: z
    .object({
      id: z.string(),
      deactivated_at: z.string(),
      is_idempotent: z.boolean(),
    })
    .optional(),
});

export const SaTombstoneResponseSchema = z.object({
  data: z.object({ status: z.string().optional() }).optional(),
  status: z.string().optional(),
});

export type CatalogDeprecateResponse = z.infer<typeof CatalogDeprecateResponseSchema>;
export type OrgSubscriptionDeactivateResponse = z.infer<
  typeof OrgSubscriptionDeactivateResponseSchema
>;
export type SaTombstoneResponse = z.infer<typeof SaTombstoneResponseSchema>;
