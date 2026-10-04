import type { FastifyInstance, RouteOptions } from "fastify";

export {
  ORG_DEFAULT_PRINCIPAL_ID,
  extractFromExecutionClaims,
  extractFromLogtoClaims,
  resolveRateLimitPrincipalId,
  type ActorType,
  type ResolvedIdentity,
} from "./identity.js";

export {
  PLATFORM_ADMIN_ROLES,
  PLATFORM_ADMIN_SCOPE,
  hasPlatformAdminAccess,
  hasPlatformAdminScope,
  isPlatformAdmin,
} from "./platform-admin.js";

export {
  ORG_ADMIN_ROLES,
  ORG_BUILD_ROLES,
  ORG_ROLE_NAMES,
  ORG_ROLE_NAME_MAX_LENGTH,
  ORG_ROLE_NAME_PATTERN,
  isOrgAdmin,
  isOrgBuilder,
  isOrgRoleNameShape,
  type OrgRoleName,
} from "./org-roles.js";

const DEFAULT_PUBLIC_PATHS = new Set([
  "/health",
  "/health/deep",
  "/ready",
  "/version",
  "/metrics",
  "/",
]);

/**
 * Path shapes that must never be reachable without authentication.
 *
 * ## What this guards
 *
 * A2A splits agent discovery in two. The **basic** Agent Card is a public
 * document by design — it is what an external caller reads *before* it holds
 * any credential, and this gateway serves it on exactly that basis.
 * The **extended** card is the opposite: same shape, but it exists to disclose
 * the skills, interfaces, and metadata an agent reveals only to an
 * already-authenticated caller. The two differing by one word in a path is
 * precisely what makes this worth a machine check rather than review vigilance
 * — the mistake looks like the correct thing.
 *
 * ## Why here and not in `auth-proxy`
 *
 * It could be framed as a guardrail on the per-pod `auth-proxy` sidecar's
 * `BYPASS_PATHS`, but no agent pod serves any Agent Card route at all — pods
 * are never internet-reachable — so there is no per-pod path left to guard. The only surface that can publish an Agent Card
 * to the internet is this gateway, and the only mechanisms that can make a
 * gateway route public are the two below: membership in `DEFAULT_PUBLIC_PATHS`
 * / `AuthGateOptions.publicPaths`, and a per-route `config: { public: true }`.
 * Both funnel through `installAuthGate`, which is why the check lives here.
 *
 * ## What it deliberately does not cover
 *
 * A2A v1.0 exposes the extended card as a JSON-RPC method
 * (`GetExtendedAgentCard`) on the agent's ordinary endpoint, not as a distinct
 * path. A path-shaped lint cannot see that, and is not meant to: the gateway's
 * JSON-RPC surface (`POST /a2a/v1/agents/:agentId`) authenticates every
 * call and does not implement the method at all. This check covers the
 * path-shaped half of the risk, which is the half that `config.public` can
 * open by accident.
 */
const EXTENDED_AGENT_CARD_FRAGMENTS: readonly string[] = [
  // `/.well-known/agent-card-extended.json`, `/extendedAgentCard`, …
  "extendedagentcard",
  // `/agent-card/extended`, `/agentCardExtended`, …
  "agentcardextended",
  // A2A v0.3's `/agent/authenticatedExtendedCard`, and anything else that
  // pairs "extended" directly with "card".
  "extendedcard",
];

/**
 * Does this route path look like an extended Agent Card?
 *
 * Separators are erased before matching, so `agent-card-extended`,
 * `agent_card_extended`, `agentCardExtended` and `/agent/card/extended` all
 * read the same. Erasing them across segment boundaries can in principle pair
 * an "extended" in one segment with a "card" in the next; that is the
 * conservative direction for a security guardrail, and no legitimate NovaOS
 * route has ever had that shape.
 */
export function isExtendedAgentCardPath(url: string): boolean {
  const normalized = url.toLowerCase().replace(/[^a-z]/g, "");
  return EXTENDED_AGENT_CARD_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Raised when a route matching {@link isExtendedAgentCardPath} is made public. */
export class PublicRoutePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicRoutePolicyError";
  }
}

function rejectExtendedAgentCardPath(url: string, mechanism: string): never {
  throw new PublicRoutePolicyError(
    `Refusing to serve "${url}" without authentication: it matches the extended ` +
      `Agent Card shape, which A2A defines as an authenticated-only document ` +
      `(made public via ${mechanism}). The basic Agent Card is public and is served ` +
      `by the gateway's agent-card route; the extended card must not be.`
  );
}

export interface AuthGateOptions {
  publicPaths?: string[];
}

const violationsMap = new WeakMap<FastifyInstance, string[]>();

/**
 * Retrieve auth gate violations collected by installAuthGate.
 * Call after `await app.ready()`.
 */
export function getAuthGateViolations(app: FastifyInstance): string[] {
  return [...(violationsMap.get(app) ?? [])];
}

/**
 * Install auth gate hooks directly on a Fastify instance (not scoped).
 * Hooks apply to all routes including those registered later via plugins.
 * Call BEFORE registering routes.
 */
export function installAuthGate(fastify: FastifyInstance, opts: AuthGateOptions = {}): void {
  const publicPaths = new Set([...DEFAULT_PUBLIC_PATHS, ...(opts.publicPaths ?? [])]);
  const violations: string[] = [];
  violationsMap.set(fastify, violations);

  // First of the two mechanisms: a path declared public up-front, in
  // `DEFAULT_PUBLIC_PATHS` or by a caller. Checked before any route registers
  // so the failure names the declaration, not whichever route happened to
  // match it first.
  for (const path of publicPaths) {
    if (isExtendedAgentCardPath(path)) {
      rejectExtendedAgentCardPath(
        path,
        DEFAULT_PUBLIC_PATHS.has(path) ? "DEFAULT_PUBLIC_PATHS" : "AuthGateOptions.publicPaths"
      );
    }
  }

  fastify.addHook("onRoute", (routeOptions: RouteOptions) => {
    const url = routeOptions.url;
    const isPublicPath = publicPaths.has(url);
    const isPublicConfig = Boolean(
      (routeOptions.config as Record<string, unknown> | undefined)?.public
    );

    // Second mechanism: `config: { public: true }` on the route itself.
    // Throwing rather than recording a violation is deliberate — a violation
    // is a report a test reads, and this must be a condition the gateway
    // cannot boot with. Fastify surfaces the throw out of `register()`, so the
    // process fails closed instead of serving the route.
    if ((isPublicPath || isPublicConfig) && isExtendedAgentCardPath(url)) {
      rejectExtendedAgentCardPath(url, isPublicConfig ? "config.public" : "a public path");
    }

    if (isPublicPath) return;
    if (isPublicConfig) return;

    const preHandlers = routeOptions.preHandler;
    const hasAuth =
      typeof preHandlers === "function" || (Array.isArray(preHandlers) && preHandlers.length > 0);

    if (!hasAuth) {
      violations.push(`${String(routeOptions.method)} ${url}`);
    }
  });
}
