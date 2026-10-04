/**
 * The `user-context/v1` A2A extension — sealed `context.secrets` delivery,
 * sealing side.
 *
 * This extension is the way a run's resolved secrets reach an agent pod, on
 * the explicit condition that NovaOS encrypt them itself — the
 * protocol carries extension data as plain JSON in the request `metadata` map
 * and gives it no confidentiality of its own.
 *
 * This module is small on purpose. The two hard parts are already solved:
 * `../crypto/sealed-envelope.js` knows how to seal a value to one pod for one
 * delivery, and `./wire.js` knows how to render the activation header. What is
 * left is the agreement between the two sides about *where* the ciphertext
 * goes, and that is all this file is.
 *
 * ## The wire shape
 *
 * ```json
 * {
 *   "metadata": {
 *     "novaos.platform/extensions/user-context/v1": {
 *       "secrets": {
 *         "OPENAI_API_KEY": { "v": 1, "suite": "…", "kid": "…", "epk": "…", "iv": "…", "ct": "…" },
 *         "SMTP_PASSWORD":  { "v": 1, … }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * A wrapper object rather than a bare secret map, so `v1` can grow a sibling
 * field without becoming `v2` and invalidating every Agent Card that declared
 * this URI. `mcp_gateway_token` is the named candidate — it travels in the clear
 * in `novaos.platform/context` today, which `adapter.ts` records as unchanged
 * ACP-era exposure rather than something this ticket accepted.
 *
 * **Secret names travel in the clear.** A pod must route a value to
 * `ctx.get_secret("SMTP_PASSWORD")` before it can decrypt anything, and the
 * ADR's threat model is disclosure of credential *values*, not of the fact that
 * an agent sends mail. A caller who considers a name itself sensitive should not
 * put it in a secret map.
 *
 * ## Activation is required, and it is not optional politeness
 *
 * A2A only dispatches an extension the caller named in the `A2A-Extensions`
 * header. A request that publishes the metadata without the header reaches a pod
 * that puts the URI in `ignored` and serves the run anyway — with every
 * `ctx.get_secret` raising. So {@link buildUserContextExtension} returns the
 * header and the metadata *together*, and callers merge both or neither.
 *
 * Pod side: `novaos_client_sdk.a2a_user_context` (`UserContextExtension`,
 * `ctx.get_secret`). Normative envelope spec: `docs/security/sealed-envelope-v1.md`.
 */

import type { X25519PublicJwk } from "../crypto/recipient-key.js";
import type { SealedEnvelope, SealedEnvelopeBinding } from "../crypto/sealed-envelope.js";
import { sealSecrets } from "../crypto/sealed-envelope.js";

import { a2aExtensionsHeader } from "./wire.js";

/**
 * The extension's identifying URI, fixed by the ADR (F7/G1).
 *
 * Matched **exactly** on both sides — A2A gives extension URIs no
 * normalisation rules, so a trailing slash makes a different extension. It is a
 * constant here and a constant in `novaos_client_sdk.a2a_user_context`, never a
 * string literal at a call site.
 */
export const USER_CONTEXT_EXTENSION_URI = "novaos.platform/extensions/user-context/v1";

/** The payload field holding the sealed secret map. */
export const USER_CONTEXT_SECRETS_FIELD = "secrets";

/**
 * The `user-context/v1` payload, as it sits under the extension's URI.
 *
 * `secrets` is optional because a run for an instance that declares none still
 * activates the extension: "activated, nothing to deliver" is a state the pod
 * reads as no secrets, and it is not the same as never having negotiated.
 */
export interface UserContextPayload {
  secrets?: Record<string, SealedEnvelope>;
}

/**
 * The run one payload is built for.
 *
 * The same three identifiers every envelope's binding is built from, minus
 * `secretName` — that one is per-value, and {@link buildUserContextExtension}
 * fills it in from the map key so the two can never disagree.
 */
export type UserContextDelivery = Omit<SealedEnvelopeBinding, "secretName">;

/**
 * What a caller merges into an outbound A2A request to deliver secrets.
 *
 * Both halves or neither: the metadata without the header is a payload no pod
 * will dispatch, and the header without the metadata activates an extension
 * that then carries nothing.
 */
export interface UserContextExtensionRequest {
  /** Merge into the request's `params.metadata`. */
  metadata: Record<string, UserContextPayload>;
  /** Merge into the request's HTTP headers. */
  headers: Record<string, string>;
}

/**
 * Seal a run's secrets for one pod and render the request fragments.
 *
 * @param secrets - The resolved `name → value` map. An empty map is legitimate
 *   and still activates the extension: the pod then knows delivery was
 *   attempted and produced nothing, which is a different fact from the caller
 *   not speaking this extension at all — and it is the difference between
 *   `ctx.get_secret` reporting "this instance declares no such secret" and
 *   "secrets are not being delivered to this pod".
 * @param recipient - The destination pod's public JWK, from
 *   `RecipientKeyring.ensureSealingKey(scope)`. Only that pod holds the private
 *   half.
 * @param delivery - The run being dispatched. Every envelope is bound to it, so
 *   one lifted out of this request and replayed into another fails to open.
 * @returns The metadata fragment and the activation header.
 * @throws {import("../crypto/sealed-envelope.js").SealedEnvelopeError} If a
 *   value is over the size limit, or the recipient JWK is unusable. A run
 *   failing loudly here is the correct outcome: the alternative is dispatching
 *   an agent that will discover mid-execution that it has no credentials.
 */
export function buildUserContextExtension(
  secrets: Readonly<Record<string, string>>,
  recipient: X25519PublicJwk,
  delivery: UserContextDelivery
): UserContextExtensionRequest {
  return {
    metadata: {
      [USER_CONTEXT_EXTENSION_URI]: { secrets: sealSecrets(secrets, recipient, delivery) },
    },
    headers: a2aExtensionsHeader([USER_CONTEXT_EXTENSION_URI]),
  };
}

/**
 * Activate the extension while delivering nothing.
 *
 * For a run whose instance declares no secrets — which is most of them. It
 * exists so that case does not have to travel as *silence*: a pod that sees the
 * extension active and empty knows delivery is working and this instance simply
 * has no secrets, whereas a pod that sees no activation at all cannot tell that
 * from a caller who does not speak this extension. On the pod side those are
 * two different `ctx.get_secret` messages, and the difference is most of what
 * makes "why is my agent missing its API key?" answerable.
 *
 * It also costs nothing: with no values to seal there is no recipient key to
 * fetch, so a secretless fleet agent never mints one.
 */
export function emptyUserContextExtension(): UserContextExtensionRequest {
  return {
    metadata: { [USER_CONTEXT_EXTENSION_URI]: { secrets: {} } },
    headers: a2aExtensionsHeader([USER_CONTEXT_EXTENSION_URI]),
  };
}
