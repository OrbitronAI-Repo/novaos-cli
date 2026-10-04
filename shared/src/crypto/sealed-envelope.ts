/**
 * NovaOS Sealed Envelope v1 — the sealing half.
 *
 * A2A carries extension data as **plain JSON in the request body's `metadata`
 * map**, activated by the `A2A-Extensions` header. The protocol provides no
 * confidentiality for it whatsoever: it is visible to exactly the same
 * infrastructure a request header would be — proxies, the auth-proxy sidecar,
 * and APM tooling that records request bodies. NovaOS uses the extension
 * mechanism for secret delivery *anyway*, on the condition that it build and
 * operate its own encryption on top. This module is that encryption.
 *
 * **What it protects against, and what it does not.** The threat is a passive
 * reader of the request between the Temporal worker and the agent process: a
 * logging proxy, a sidecar, an APM agent that samples bodies, a Temporal
 * payload dump. Against that reader a sealed value is opaque, because the only
 * key that opens it lives inside the destination pod. It is *not* protection
 * against the worker (which holds the plaintext by construction — it is the
 * sender), nor against the agent code itself (which is the intended reader),
 * nor against a caller who can rewrite the whole request (they cannot forge an
 * envelope, but they can drop one).
 *
 * **The suite.** X25519 ECDH with a fresh ephemeral sender key per envelope,
 * HKDF-SHA256 to a 256-bit content key, AES-256-GCM to seal. This is the
 * classic ECIES shape, and it is deliberately built from `node:crypto`
 * primitives rather than a JOSE library: the pod half of this subsystem is
 * Python (`novaos_client_sdk.a2a_sealed_envelope`), and the two must agree
 * byte-for-byte. A hand-written, fully specified suite is verifiable by shared
 * test vectors; "whatever two JOSE libraries both call ECDH-ES+A256GCM" is not.
 * See `docs/security/sealed-envelope-v1.md` for the normative wire spec.
 *
 * **Every envelope is bound to one delivery.** The AEAD's additional
 * authenticated data commits to the run, tenant, instance and secret name the
 * envelope was sealed for (:type:`SealedEnvelopeBinding`). The pod recomputes
 * that binding from the identifiers *it* sees and opens the envelope against
 * it, so a valid envelope lifted out of one run and replayed into another —
 * another tenant's run, or the same run under a different secret name — fails
 * to open rather than silently delivering the wrong value. The binding is
 * never transmitted; it is recomputed on both sides, which is what makes the
 * check meaningful.
 *
 * **This module does not place anything in `metadata`.** Choosing the
 * extension URI, assembling the extension payload and putting it on the wire
 * is the caller's job; this module is the sealing subsystem it calls.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  jwkThumbprint,
  publicKeyObjectFromJwk,
  privateKeyObjectFromJwk,
  rawPublicKeyFromJwk,
  type X25519PrivateJwk,
  type X25519PublicJwk,
} from "./recipient-key.js";

// ---------------------------------------------------------------------------
// Suite constants
// ---------------------------------------------------------------------------

/**
 * The full cipher suite label. It is mixed into both the HKDF `info` and the
 * AEAD's additional data, so an envelope sealed under a future suite cannot be
 * opened as a v1 one even if the JSON shape happens to still parse.
 *
 * Changing any primitive means a new label and a new {@link SEALED_ENVELOPE_VERSION},
 * never a silent substitution.
 */
export const SEALED_ENVELOPE_SUITE = "NOVAOS-SEAL-X25519-HKDF-SHA256-AES256GCM/v1" as const;

/** The envelope format version carried in the JSON as `v`. */
export const SEALED_ENVELOPE_VERSION = 1 as const;

/** AES-GCM nonce length, in bytes. 96 bits — the only size GCM is defined for at full strength. */
const NONCE_BYTES = 12;

/** AES-GCM authentication tag length, in bytes. */
const TAG_BYTES = 16;

/** Content-encryption key length, in bytes. */
const CONTENT_KEY_BYTES = 32;

/** X25519 raw key length, in bytes (both halves). */
const X25519_KEY_BYTES = 32;

/**
 * The largest plaintext this module will seal, in bytes.
 *
 * Secret *values* are credentials — API keys, tokens, passwords. A megabyte-long
 * one is a caller mistake (a file, a whole config blob), and sealing it would
 * put a megabyte of base64 into an A2A request body that already has a ~5 MB
 * route limit. Refusing is better than silently producing a request the gateway
 * will reject downstream for reasons that no longer mention secrets.
 */
export const MAX_SEALED_PLAINTEXT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The delivery an envelope is sealed for.
 *
 * Every field is an identifier both sides already know independently: the
 * worker from the run it is dispatching, the pod from the request it is
 * serving. None of them is secret — the point is not to hide them but to make
 * the ciphertext refuse to open anywhere else.
 */
export interface SealedEnvelopeBinding {
  /** The run this secret is being delivered for. */
  runId: string;
  /** The tenant the run belongs to. */
  tenantId: string;
  /** The user-agent instance the run executes. */
  instanceId: string;
  /**
   * The name the secret will be delivered under. Binds a value to its key, so
   * an envelope cannot be moved from `SMTP_PASSWORD` to `API_KEY` within the
   * same run.
   */
  secretName: string;
}

/**
 * A sealed value, as it travels inside the A2A request `metadata` map.
 *
 * Field names are short because this is a wire format that will be repeated
 * once per secret in every fleet request; they are not abbreviations anyone is
 * expected to read at a glance. `docs/security/sealed-envelope-v1.md` is the
 * normative description.
 */
export interface SealedEnvelope {
  /** Format version. Always {@link SEALED_ENVELOPE_VERSION} for this module. */
  v: number;
  /** Cipher suite label. Always {@link SEALED_ENVELOPE_SUITE} for this module. */
  suite: string;
  /** Recipient key id — the JWK thumbprint of the pod public key used. */
  kid: string;
  /** Ephemeral sender X25519 public key, base64url, unpadded, 32 raw bytes. */
  epk: string;
  /** AES-GCM nonce, base64url, unpadded, 12 raw bytes. */
  iv: string;
  /** Ciphertext concatenated with the 16-byte GCM tag, base64url, unpadded. */
  ct: string;
}

/**
 * Raised for every failure in this module.
 *
 * Deliberately uniform and deliberately terse: `reason` distinguishes a caller
 * mistake (a malformed envelope, an unknown key) from a cryptographic failure,
 * but no variant ever carries plaintext, key material, or the ciphertext. A
 * decryption failure in particular says only that it failed — which byte
 * failed is exactly the oracle an attacker would want.
 */
export class SealedEnvelopeError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "malformed_envelope"
      | "unsupported_suite"
      | "recipient_mismatch"
      | "plaintext_too_large"
      | "decrypt_failed"
  ) {
    super(message);
    this.name = "SealedEnvelopeError";
  }
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function b64u(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * Decode unpadded base64url, rejecting anything that does not round-trip.
 *
 * `Buffer.from(s, "base64url")` is famously permissive — it skips characters it
 * does not recognise rather than failing, so `"!!!!"` decodes to an empty
 * buffer instead of an error. Re-encoding and comparing is the cheapest way to
 * turn that into the strict parser a wire format needs.
 */
function unb64u(value: unknown, field: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new SealedEnvelopeError(
      `sealed envelope field '${field}' must be a string`,
      "malformed_envelope"
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new SealedEnvelopeError(
      `sealed envelope field '${field}' is not valid base64url`,
      "malformed_envelope"
    );
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new SealedEnvelopeError(
      `sealed envelope field '${field}' must decode to ${expectedBytes} bytes, got ${decoded.length}`,
      "malformed_envelope"
    );
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Key schedule
// ---------------------------------------------------------------------------

/**
 * Length-prefixed concatenation.
 *
 * Both the HKDF `info` and the AEAD's additional data are built from several
 * variable-length strings, and both are reconstructed independently by a Python
 * implementation. A plain join on a delimiter would be ambiguous the moment a
 * tenant id or secret name contained that delimiter — `("a:b", "c")` and
 * `("a", "b:c")` would produce identical bytes, which is precisely the
 * confusion the binding exists to prevent. A 4-byte big-endian length in front
 * of every field removes the ambiguity and is trivial to reimplement exactly.
 */
function lengthPrefixed(parts: readonly (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The HKDF `info` string: the suite label, then both public keys.
 *
 * Including the ephemeral and recipient public keys is what makes this a KEM
 * context rather than a bare DH output — two envelopes that happen to share a
 * shared secret (they cannot, but the construction should not depend on that)
 * still derive different content keys, and a content key is inseparable from
 * the pair of keys it was agreed between.
 *
 * HKDF's salt is deliberately empty: there is no per-envelope entropy the
 * recipient could learn that the ephemeral public key does not already carry,
 * and an empty salt is the one value both Node's `hkdfSync` and Python's
 * `HKDF(salt=b"")` agree on without further specification.
 */
function contentKey(
  sharedSecret: Buffer,
  ephemeralPublicRaw: Buffer,
  recipientPublicRaw: Buffer
): Buffer {
  const info = lengthPrefixed([SEALED_ENVELOPE_SUITE, ephemeralPublicRaw, recipientPublicRaw]);
  return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), info, CONTENT_KEY_BYTES));
}

/**
 * The AEAD additional data: the suite, the recipient key id, and the delivery.
 *
 * This is never transmitted. Both sides build it from values they hold
 * independently, so it authenticates *the circumstances of delivery* rather
 * than anything in the envelope — which is the whole point. An envelope moved
 * to a different run, tenant, instance or secret name is opened against
 * different additional data and fails its tag check.
 */
function additionalData(kid: string, binding: SealedEnvelopeBinding): Buffer {
  return lengthPrefixed([
    SEALED_ENVELOPE_SUITE,
    kid,
    binding.tenantId,
    binding.instanceId,
    binding.runId,
    binding.secretName,
  ]);
}

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

/**
 * Seal one secret value for one pod, for one delivery.
 *
 * @param plaintext - The secret value. Sealed as UTF-8.
 * @param recipient - The destination pod's public JWK. Only the pod holds the
 *   matching private half; see {@link ./keyring.js} for how it gets there.
 * @param binding - The delivery this envelope is valid for.
 * @returns The envelope, ready to be serialised into A2A request metadata by
 *   the caller (this module does not choose a placement).
 */
export function sealSecret(
  plaintext: string,
  recipient: X25519PublicJwk,
  binding: SealedEnvelopeBinding
): SealedEnvelope {
  const plaintextBytes = Buffer.from(plaintext, "utf8");
  if (plaintextBytes.length > MAX_SEALED_PLAINTEXT_BYTES) {
    throw new SealedEnvelopeError(
      `secret value is ${plaintextBytes.length} bytes, over the ${MAX_SEALED_PLAINTEXT_BYTES}-byte limit`,
      "plaintext_too_large"
    );
  }

  const kid = jwkThumbprint(recipient);
  const recipientKey = publicKeyObjectFromJwk(recipient);
  const recipientRaw = rawPublicKeyFromJwk(recipient);

  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = ephemeral.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-X25519_KEY_BYTES);

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  const key = contentKey(shared, ephemeralRaw, recipientRaw);
  shared.fill(0);

  const iv = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(kid, binding));
  const body = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);

  key.fill(0);
  plaintextBytes.fill(0);

  return {
    v: SEALED_ENVELOPE_VERSION,
    suite: SEALED_ENVELOPE_SUITE,
    kid,
    epk: b64u(ephemeralRaw),
    iv: b64u(iv),
    ct: b64u(sealed),
  };
}

/**
 * Seal a whole `context.secrets` map for one pod and one run.
 *
 * Each value gets its own envelope, its own ephemeral key and its own binding —
 * there is no shared content key across the map. That costs one X25519
 * operation per secret (tens of microseconds) and buys per-value isolation:
 * compromising one envelope reveals nothing about its siblings, and no envelope
 * can be moved between names.
 *
 * The **names stay in the clear**, by design. A pod must be able to route a
 * value to `ctx.get_secret("SMTP_PASSWORD")` before it decrypts anything, and
 * the ADR's threat model is disclosure of credential *values*, not of the fact
 * that an agent uses SMTP. Callers who consider a name itself sensitive should
 * not put it in a secret map.
 */
export function sealSecrets(
  secrets: Readonly<Record<string, string>>,
  recipient: X25519PublicJwk,
  binding: Omit<SealedEnvelopeBinding, "secretName">
): Record<string, SealedEnvelope> {
  const out: Record<string, SealedEnvelope> = {};
  for (const [name, value] of Object.entries(secrets)) {
    out[name] = sealSecret(value, recipient, { ...binding, secretName: name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open a sealed envelope with the recipient's private key.
 *
 * **In production this runs in the pod, in Python** — see
 * `novaos_client_sdk.a2a_sealed_envelope.open_envelope`. The TypeScript
 * implementation exists so the format has an executable definition on the
 * sealing side too: `sealed-envelope.test.ts` round-trips through it, and
 * `sealed-envelope.vectors.test.ts` checks it against the same fixed vectors
 * the Python side checks against. Without it, a change to the key schedule
 * here would only be caught in a cross-repo integration run.
 *
 * @throws {SealedEnvelopeError} with `reason: "decrypt_failed"` for every
 *   cryptographic failure, whether the cause was a wrong key, a tampered
 *   ciphertext or a binding mismatch. The three are not distinguished on
 *   purpose: telling a caller *which* one failed is a decryption oracle.
 */
export function openSecret(
  envelope: unknown,
  recipientPrivate: X25519PrivateJwk,
  binding: SealedEnvelopeBinding
): string {
  const parsed = parseEnvelope(envelope);

  const kid = jwkThumbprint(recipientPrivate);
  if (parsed.kid !== kid) {
    throw new SealedEnvelopeError(
      `envelope is sealed for key '${parsed.kid}', not '${kid}'`,
      "recipient_mismatch"
    );
  }

  const epkRaw = unb64u(parsed.epk, "epk", X25519_KEY_BYTES);
  const iv = unb64u(parsed.iv, "iv", NONCE_BYTES);
  const sealed = unb64u(parsed.ct, "ct");
  if (sealed.length < TAG_BYTES) {
    throw new SealedEnvelopeError(
      "sealed envelope field 'ct' is shorter than the GCM tag",
      "malformed_envelope"
    );
  }

  const recipientRaw = rawPublicKeyFromJwk(recipientPrivate);

  // Curve25519 has a handful of low-order points — all-zero among them — whose
  // shared secret is the identity, and Node refuses them with
  // `ERR_CRYPTO_OPERATION_FAILED`. An `epk` naming one is perfectly well-formed,
  // so it passes every check above and would otherwise escape as an error no
  // caller of this module is told to expect. It is reported as the same failure
  // a wrong key gives: an attacker who can tell "your key rejected my point"
  // from "your key decrypted to garbage" has learned something about the key.
  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: privateKeyObjectFromJwk(recipientPrivate),
      publicKey: createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, epkRaw]),
        format: "der",
        type: "spki",
      }),
    });
  } catch {
    throw new SealedEnvelopeError("sealed envelope failed to open", "decrypt_failed");
  }

  const key = contentKey(shared, epkRaw, recipientRaw);
  shared.fill(0);

  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(additionalData(parsed.kid, binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new SealedEnvelopeError("sealed envelope failed to open", "decrypt_failed");
  } finally {
    key.fill(0);
  }
}

/**
 * The DER prefix an X25519 SPKI carries in front of its 32 raw key bytes.
 *
 * Node's `createPublicKey` has no raw-X25519 import, so a raw key is imported
 * by re-attaching the fixed prefix. It is fixed because the algorithm fixes the
 * key length — there is no variable-length field in an X25519 SPKI header.
 */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/**
 * Validate the JSON shape of an envelope before any key material is touched.
 *
 * Every field is checked here so the crypto path below can assume well-formed
 * input, and so a malformed envelope is reported as malformed rather than
 * surfacing as an opaque decryption failure.
 */
function parseEnvelope(value: unknown): SealedEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SealedEnvelopeError("sealed envelope must be a JSON object", "malformed_envelope");
  }
  const raw = value as Record<string, unknown>;

  if (raw.v !== SEALED_ENVELOPE_VERSION) {
    throw new SealedEnvelopeError(
      `unsupported sealed envelope version ${String(raw.v)}`,
      "unsupported_suite"
    );
  }
  // Compared in constant time only for uniformity with the rest of the module;
  // the suite label is public, so this is hygiene rather than a real leak.
  if (typeof raw.suite !== "string" || !equalStrings(raw.suite, SEALED_ENVELOPE_SUITE)) {
    throw new SealedEnvelopeError(
      `unsupported sealed envelope suite '${String(raw.suite)}'`,
      "unsupported_suite"
    );
  }
  if (typeof raw.kid !== "string" || raw.kid.length === 0) {
    throw new SealedEnvelopeError(
      "sealed envelope field 'kid' must be a non-empty string",
      "malformed_envelope"
    );
  }

  // Force the base64url fields through the strict decoder now, so a caller that
  // only ever calls parseEnvelope still gets the strict check.
  unb64u(raw.epk, "epk", X25519_KEY_BYTES);
  unb64u(raw.iv, "iv", NONCE_BYTES);
  unb64u(raw.ct, "ct");

  return {
    v: raw.v,
    suite: raw.suite,
    kid: raw.kid,
    epk: raw.epk as string,
    iv: raw.iv as string,
    ct: raw.ct as string,
  };
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
