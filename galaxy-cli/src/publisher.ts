/**
 * Publisher slug discovery for galaxy-cli.
 *
 * Marketplace stores the slug on publisher_profiles.name; JWTs often omit
 * publisher_name. CLI discovers it via GET /api/developer/publisher (Bearer).
 */

import { getErrorMessage } from "@novaos-cli/shared/utils";
import { z } from "zod";

import { resolveMarketplaceAdminUrl } from "./app-provision/config.js";
import {
  extractErrorDetail,
  withRequestId,
  type GalaxyHttpClient,
  createGalaxyHttpClient,
} from "./http-client.js";

export const PUBLISHER_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export interface PublisherProfileSummary {
  id: string;
  name: string;
  display_name?: string | null;
  status?: string;
}

export type PublisherLookupResult =
  | { status: "found"; publisher: PublisherProfileSummary }
  | { status: "none" }
  | { status: "error"; message: string };

/**
 * Contract for GET /api/developer/publisher's success envelope.
 * A manual `interface` here would never notice when Marketplace
 * renames/removes a field, so safeParse the envelope before reading it.
 */
const PublisherProfileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string().nullish(),
  status: z.string().optional(),
});

const MarketplacePublisherEnvelopeSchema = z.object({
  data: z
    .object({
      publisher: PublisherProfileSummarySchema.nullable().optional(),
    })
    .optional(),
});

export function isValidPublisherSlug(value: string): boolean {
  return PUBLISHER_SLUG_PATTERN.test(value);
}

/** Logto subjects commonly start with a digit; publisher slugs must start with a letter. */
export function looksLikeLogtoSubject(value: string): boolean {
  return /^[0-9]/.test(value);
}

export function formatInvalidPublisherError(publisher: string): string {
  const formatHint =
    "Publisher slug must be lowercase, start with a letter, and contain only letters, numbers, and hyphens (max 63 chars).";

  if (looksLikeLogtoSubject(publisher)) {
    return (
      `Invalid publisher "${publisher}". That looks like a Logto user id (subject), not a publisher slug.\n` +
      `${formatHint}\n` +
      "Run `novaos-cli publisher show` to discover your slug for the active environment."
    );
  }

  return (
    `Invalid publisher "${publisher}". ${formatHint}\n` +
    "Run `novaos-cli publisher show` to discover your slug, or open Developer Portal → Publisher profile."
  );
}

export function marketplacePublisherProfileUrl(env: string): string {
  return `${resolveMarketplaceAdminUrl(env).replace(/\/$/, "")}/developer/profile`;
}

export function formatMissingPublisherError(env: string): string {
  return (
    "Error: could not resolve a publisher slug for init.\n" +
    "Your JWT has no publisher_name claim and Marketplace reports no publisher membership for this account.\n" +
    `Run \`novaos-cli publisher show\` (active env: ${env}), register at ${marketplacePublisherProfileUrl(env)}, or pass --publisher <slug>.\n`
  );
}

export function formatPublisherShowNoneMessage(env: string): string {
  return (
    `No publisher membership for the authenticated user on ${env}.\n` +
    `Register a publisher profile at ${marketplacePublisherProfileUrl(env)}, then re-run this command.\n`
  );
}

/**
 * Marketplace HTTP client for a specific CLI environment.
 * Callers must pass the resolved env (honors global `--env`, not only persisted active).
 */
export function createMarketplaceClientForEnv(
  env: string,
  debug = false
): {
  client: GalaxyHttpClient;
  env: string;
} {
  const baseUrl = resolveMarketplaceAdminUrl(env);
  return { client: createGalaxyHttpClient(baseUrl, { debug }), env };
}

export async function fetchPublisherLookup(
  client: GalaxyHttpClient
): Promise<PublisherLookupResult> {
  try {
    const response = await client.request<unknown>("/api/developer/publisher");
    if (!response.ok) {
      const detail = extractErrorDetail(response.data);
      return {
        status: "error",
        message: withRequestId(
          `Marketplace returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          response
        ),
      };
    }

    const parsed = MarketplacePublisherEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      return {
        status: "error",
        message: `Marketplace publisher response failed contract validation: ${parsed.error.message}`,
      };
    }

    const publisher = parsed.data.data?.publisher ?? null;
    if (!publisher || typeof publisher.name !== "string" || publisher.name.length === 0) {
      return { status: "none" };
    }

    return {
      status: "found",
      publisher: {
        id: publisher.id,
        name: publisher.name,
        display_name: publisher.display_name ?? null,
        status: publisher.status,
      },
    };
  } catch (error) {
    return { status: "error", message: getErrorMessage(error) };
  }
}

/**
 * Resolve publisher slug: explicit flag → JWT claim → Marketplace membership.
 */
export async function resolvePublisherSlugForInit(opts: {
  explicitPublisher?: string;
  jwtPublisherName?: string;
  env: string;
  lookup: () => Promise<PublisherLookupResult>;
}): Promise<{ ok: true; publisher: string } | { ok: false; message: string }> {
  if (opts.explicitPublisher) {
    return { ok: true, publisher: opts.explicitPublisher };
  }
  if (opts.jwtPublisherName) {
    return { ok: true, publisher: opts.jwtPublisherName };
  }

  const result = await opts.lookup();
  if (result.status === "found") {
    return { ok: true, publisher: result.publisher.name };
  }
  if (result.status === "error") {
    return {
      ok: false,
      message:
        `Error: could not resolve publisher slug (${result.message}).\n` +
        "Pass --publisher <slug>, or run `novaos-cli publisher show` after fixing auth.\n" +
        `Profile: ${marketplacePublisherProfileUrl(opts.env)}\n`,
    };
  }
  return { ok: false, message: formatMissingPublisherError(opts.env) };
}
