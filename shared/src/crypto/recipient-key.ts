/**
 * Recipient key material for the NovaOS Sealed Envelope.
 *
 * A *recipient key* is the X25519 key pair whose private half lives inside an
 * agent pod and whose public half the Temporal worker seals to. This module
 * owns the representation of that key — how it is generated, how it is named,
 * and how it converts between the JWK form NovaOS transports it in and the
 * `KeyObject` form `node:crypto` operates on. It owns none of the lifecycle:
 * when to mint one, how long it lives, and what to do when it leaks are
 * `./keyring.ts`'s concerns.
 *
 * **Why JWK.** The platform already speaks JWK for keys that cross a process
 * boundary — the auth-proxy sidecar reads a JWK Set from `/etc/jwks`, and the
 * SDK's `JWKSTokenVerifier` selects a signing key by `kid` from a JWK Set. Using
 * the same shape for recipient keys means the pod-side loader is the familiar
 * "JWK Set, pick by `kid`" pattern rather than a NovaOS-only encoding, and it
 * means both the TypeScript and Python halves have a well-specified target
 * (RFC 8037 for the OKP key type, RFC 7638 for the thumbprint) instead of an
 * agreed-by-accident byte layout.
 *
 * **Why the `kid` is a thumbprint and not a UUID.** An RFC 7638 thumbprint is a
 * deterministic function of the public key itself, so it cannot drift from the
 * key it names, cannot be reassigned to a different key, and is computed
 * identically by the sealing and opening sides without either having to be told
 * it. A random id would have to be carried alongside the key everywhere and
 * would be one more thing that can be wrong.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/** JWK key type for the Edwards/Montgomery curve family (RFC 8037). */
const OKP = "OKP" as const;

/** The only curve this subsystem uses. */
const X25519 = "X25519" as const;

/** X25519 raw key length, in bytes. */
const X25519_KEY_BYTES = 32;

/**
 * A public recipient key, in JWK form.
 *
 * `use: "enc"` is set on every key this module mints. It is advisory in JWK
 * terms, but it is the field that stops a recipient key from ever being
 * mistaken for one of the platform's RS256 *signing* keys if the two ever end
 * up in the same set — which is exactly the mix-up that makes key-reuse bugs
 * hard to see.
 */
export interface X25519PublicJwk {
  kty: typeof OKP;
  crv: typeof X25519;
  /** Public key, base64url, unpadded, 32 raw bytes. */
  x: string;
  /** RFC 7638 thumbprint of this key. */
  kid: string;
  use: "enc";
}

/** A recipient key including its private half. Never leaves the pod it belongs to. */
export interface X25519PrivateJwk extends X25519PublicJwk {
  /** Private scalar, base64url, unpadded, 32 raw bytes. */
  d: string;
}

/** A freshly generated recipient key pair, split into the two halves that go different places. */
export interface RecipientKeyPair {
  /** Published to whoever seals. Safe to log, store and transmit. */
  publicJwk: X25519PublicJwk;
  /**
   * Delivered to exactly one pod and then dropped. Never persisted by the
   * control plane, never logged, never returned by an API.
   */
  privateJwk: X25519PrivateJwk;
  /** Convenience: the thumbprint both halves carry. */
  kid: string;
}

/** Raised when a value that claims to be a recipient JWK is not one. */
export class RecipientKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientKeyError";
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Mint a new recipient key pair.
 *
 * The private half exists in this process only long enough to be handed to a
 * key sink (see `./keyring.ts`). Callers must not persist or log it; the type
 * is separate from {@link X25519PublicJwk} precisely so that "which half am I
 * holding" is a question the compiler answers.
 */
export function generateRecipientKeyPair(): RecipientKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-X25519_KEY_BYTES);
  const rawPrivate = privateKey
    .export({ type: "pkcs8", format: "der" })
    .subarray(-X25519_KEY_BYTES);

  const x = rawPublic.toString("base64url");
  const kid = thumbprintFromX(x);

  return {
    kid,
    publicJwk: { kty: OKP, crv: X25519, x, kid, use: "enc" },
    privateJwk: { kty: OKP, crv: X25519, x, kid, use: "enc", d: rawPrivate.toString("base64url") },
  };
}

/** Strip the private half off a key pair member, for publication. */
export function toPublicJwk(jwk: X25519PublicJwk | X25519PrivateJwk): X25519PublicJwk {
  return { kty: OKP, crv: X25519, x: jwk.x, kid: jwk.kid, use: "enc" };
}

// ---------------------------------------------------------------------------
// Thumbprint
// ---------------------------------------------------------------------------

/**
 * The RFC 7638 thumbprint of a recipient key.
 *
 * RFC 8037 §2 fixes the member set for an OKP key at `crv`, `kty` and `x`, and
 * RFC 7638 fixes the serialisation at those members in lexicographic order,
 * as compact JSON with no whitespace. Both are spelled out here rather than
 * delegated to a JSON serialiser, because the Python half computes the same
 * value from the same rule and `JSON.stringify` on an object literal is a
 * promise about key order that TypeScript does not actually make.
 */
export function jwkThumbprint(jwk: X25519PublicJwk | X25519PrivateJwk): string {
  assertPublicShape(jwk);
  return thumbprintFromX(jwk.x);
}

function thumbprintFromX(x: string): string {
  const canonical = `{"crv":"${X25519}","kty":"${OKP}","x":"${x}"}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

// ---------------------------------------------------------------------------
// Validation and conversion
// ---------------------------------------------------------------------------

/**
 * Parse an untrusted value as a public recipient JWK.
 *
 * Used on every key that arrives from outside this process — a pod record read
 * back from Redis, a key handed in by an activity input. A key that fails here
 * is a configuration or storage fault, never something to seal to anyway.
 */
export function parsePublicJwk(value: unknown): X25519PublicJwk {
  assertPublicShape(value);
  const kid = thumbprintFromX(value.x);
  if (value.kid !== kid) {
    throw new RecipientKeyError(
      `recipient key 'kid' is '${value.kid}' but its thumbprint is '${kid}'`
    );
  }
  return { kty: OKP, crv: X25519, x: value.x, kid, use: "enc" };
}

/** Parse an untrusted value as a private recipient JWK. Pod-side loaders use this. */
export function parsePrivateJwk(value: unknown): X25519PrivateJwk {
  const publicPart = parsePublicJwk(value);
  const d = (value as Record<string, unknown>).d;
  assertRawB64u(d, "d");
  return { ...publicPart, d: d as string };
}

/** The 32 raw public-key bytes, decoded from a JWK's `x`. */
export function rawPublicKeyFromJwk(jwk: X25519PublicJwk | X25519PrivateJwk): Buffer {
  return Buffer.from(jwk.x, "base64url");
}

/** A `node:crypto` public `KeyObject` for a recipient JWK. */
export function publicKeyObjectFromJwk(jwk: X25519PublicJwk | X25519PrivateJwk): KeyObject {
  return createPublicKey({ key: { kty: OKP, crv: X25519, x: jwk.x }, format: "jwk" });
}

/** A `node:crypto` private `KeyObject` for a recipient JWK that has its private half. */
export function privateKeyObjectFromJwk(jwk: X25519PrivateJwk): KeyObject {
  return createPrivateKey({ key: { kty: OKP, crv: X25519, x: jwk.x, d: jwk.d }, format: "jwk" });
}

function assertPublicShape(value: unknown): asserts value is X25519PublicJwk {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecipientKeyError("recipient key must be a JWK object");
  }
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== OKP) {
    throw new RecipientKeyError(`recipient key 'kty' must be '${OKP}', got '${String(jwk.kty)}'`);
  }
  if (jwk.crv !== X25519) {
    throw new RecipientKeyError(
      `recipient key 'crv' must be '${X25519}', got '${String(jwk.crv)}'`
    );
  }
  assertRawB64u(jwk.x, "x");
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
    throw new RecipientKeyError("recipient key 'kid' must be a non-empty string");
  }
}

/**
 * Assert a JWK member is unpadded base64url decoding to exactly one X25519 key.
 *
 * The round-trip comparison is load-bearing: `Buffer.from(s, "base64url")`
 * silently ignores characters outside the alphabet, so without it a `x` of
 * `"!!!!…"` would decode to a short buffer and be rejected for the wrong
 * reason — or, at the wrong length, not rejected at all.
 */
function assertRawB64u(value: unknown, member: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecipientKeyError(`recipient key '${member}' must be a non-empty string`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new RecipientKeyError(`recipient key '${member}' is not valid unpadded base64url`);
  }
  if (decoded.length !== X25519_KEY_BYTES) {
    throw new RecipientKeyError(
      `recipient key '${member}' must decode to ${X25519_KEY_BYTES} bytes, got ${decoded.length}`
    );
  }
}
