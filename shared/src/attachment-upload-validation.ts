/**
 * Chat / gateway execute attachment validation
 * (type and magic-byte checks, plus size, count and rate limits).
 *
 * Allowlist extensions + MIME, explicit denylist for executables,
 * basename filename sanitization, magic-byte sniff vs declared MIME,
 * size → 413, attachment count, and upload-specific rate constants.
 */

export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

/** Per-file decoded size cap (aligned BFF ↔ gateway). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Max attachments per execute / chat turn. */
export const DEFAULT_MAX_ATTACHMENTS_PER_REQUEST = 10;

/**
 * Max HTTP body at the marketplace BFF before proxying.
 * Sized for one max attachment as base64 (~4/3) plus JSON overhead.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Stricter than general marketplace API RPM (100/min).
 * Stops automated attachment upload bursts (Burp Intruder-style fuzzing).
 */
export const CHAT_ATTACHMENT_UPLOAD_MAX_PER_WINDOW = 10;
export const CHAT_ATTACHMENT_UPLOAD_WINDOW_MS = 60_000;
export const CHAT_ATTACHMENT_UPLOAD_RATE_LIMIT_MAX_KEYS = 10_000;

/** Product allowlist — chat Agent File upload. */
export const CHAT_ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const CHAT_ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".txt",
  ".csv",
  ".json",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".docx",
  ".xlsx",
]);

/** Always rejected — even if a tenant policy allowlist is empty/open. */
export const CHAT_DENIED_EXTENSIONS = new Set([
  ".py",
  ".pyc",
  ".pyw",
  ".pyo",
  ".sh",
  ".bash",
  ".zsh",
  ".csh",
  ".ksh",
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".dll",
  ".so",
  ".dylib",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".jar",
  ".war",
  ".class",
  ".php",
  ".php3",
  ".php4",
  ".phtml",
  ".rb",
  ".pl",
  ".pm",
  ".cgi",
  ".asp",
  ".aspx",
  ".hta",
  ".scr",
  ".pif",
  ".reg",
  ".apk",
  ".app",
  ".deb",
  ".rpm",
  ".bin",
  ".run",
  ".elf",
]);

export const CHAT_DENIED_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-sharedlib",
  "application/x-elf",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-python",
  "application/x-python-code",
  "text/x-python",
  "text/x-script.python",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/x-bat",
  "application/x-ms-dos-executable",
  "application/java-archive",
  "application/x-java-archive",
  "application/vnd.microsoft.portable-executable",
]);

export type AttachmentContentKind =
  | "pdf"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "zip"
  | "elf"
  | "pe"
  | "script"
  | "text"
  | "unknown";

export type AttachmentValidationStatus = 400 | 413 | 415;

export type AttachmentValidationFailureCode =
  | "ATTACHMENT_TYPE_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_LIMIT_EXCEEDED";

export interface AttachmentValidationFailure {
  readonly message: string;
  readonly status: AttachmentValidationStatus;
  readonly code: AttachmentValidationFailureCode;
}

export type AttachmentValidationResult =
  | { ok: true; safeName: string; mimeType: string }
  | { ok: false; failure: AttachmentValidationFailure };

const MIME_TO_EXPECTED_KIND: Record<string, AttachmentContentKind | "text-family"> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "zip",
  "text/plain": "text-family",
  "text/csv": "text-family",
  "text/markdown": "text-family",
  "text/x-markdown": "text-family",
  "text/html": "text-family",
  "application/json": "text-family",
};

/**
 * Strip path components and reject traversal / separators / null bytes.
 * Returns null when the name is unsafe.
 */
export function sanitizeAttachmentFilename(name: string): string | null {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base.length === 0 || base.length > MAX_ATTACHMENT_FILENAME_LENGTH) {
    return null;
  }
  if (base.includes("\0") || base.includes("/") || base.includes("\\")) {
    return null;
  }
  if (base === "." || base === "..") {
    return null;
  }
  if (base.includes("..")) {
    return null;
  }
  return base;
}

export function extensionOfFilename(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return lower.slice(dot);
}

/**
 * Default basename when clients omit `name` but declare an allowlisted MIME
 * (gateway schema treats name as optional).
 */
export const MIME_TO_DEFAULT_FILENAME: Readonly<Record<string, string>> = {
  "image/png": "attachment.png",
  "image/jpeg": "attachment.jpg",
  "image/gif": "attachment.gif",
  "image/webp": "attachment.webp",
  "application/pdf": "attachment.pdf",
  "text/plain": "attachment.txt",
  "text/csv": "attachment.csv",
  "text/markdown": "attachment.md",
  "text/x-markdown": "attachment.md",
  "text/html": "attachment.html",
  "application/json": "attachment.json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "attachment.docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "attachment.xlsx",
};

export function defaultFilenameForMime(mimeType: string): string | null {
  const mime = mimeType.toLowerCase().trim();
  return MIME_TO_DEFAULT_FILENAME[mime] ?? null;
}

/**
 * Resolve a usable filename for policy checks when `name` is missing or
 * extensionless but MIME is known.
 */
export function resolveAttachmentFilename(name: string | undefined, mimeType: string): string {
  const mime = (mimeType || "").toLowerCase().trim();
  const trimmed = typeof name === "string" ? name.trim() : "";
  const fromMime = defaultFilenameForMime(mime);

  if (trimmed) {
    const safe = sanitizeAttachmentFilename(trimmed);
    if (safe && extensionOfFilename(safe)) {
      return safe;
    }
    if (safe && fromMime) {
      // Placeholder names like "unnamed" get a full MIME-derived basename.
      if (safe.toLowerCase() === "unnamed") {
        return fromMime;
      }
      return `${safe}${extensionOfFilename(fromMime)}`;
    }
    if (safe) {
      return safe;
    }
  }

  return fromMime ?? "unnamed";
}

/**
 * Magic-byte sniff for attachment policy. Returns a coarse content kind.
 */
export function sniffAttachmentContent(bytes: Uint8Array): AttachmentContentKind {
  // Empty payloads are valid for allowlisted text-family MIME types (blank .txt/.md).
  // Binary formats (pdf/png/…) still fail later because they require a matching magic kind.
  if (bytes.length === 0) {
    return "text";
  }

  // ELF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return "elf";
  }

  // PE / DOS MZ
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return "pe";
  }

  // PDF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "pdf";
  }

  // PNG
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }

  // GIF
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "gif";
  }

  // WEBP (RIFF....WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }

  // ZIP / OOXML
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  ) {
    return "zip";
  }

  // Shebang — treat as executable script content
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) {
    return "script";
  }

  // Mostly printable ASCII or valid UTF-8 Unicode text → text; otherwise unknown.
  // ASCII-only printable ratio rejects CJK/accents/emoji (high bytes); UTF-8 path
  // accepts those while still rejecting null bytes and invalid binary.
  const sampleLen = Math.min(bytes.length, 512);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) {
      return "unknown";
    }
  }
  if (isMostlyAsciiPrintable(bytes, sampleLen) || isMostlyUtf8Text(bytes, sampleLen)) {
    return "text";
  }
  return "unknown";
}

const TEXT_PRINTABLE_RATIO = 0.85;

function isMostlyAsciiPrintable(bytes: Uint8Array, sampleLen: number): boolean {
  let printable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = bytes[i]!;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) {
      printable++;
    }
  }
  return printable / sampleLen >= TEXT_PRINTABLE_RATIO;
}

/**
 * Truncate a byte sample so it does not end mid UTF-8 multi-byte sequence.
 */
function truncateToCompleteUtf8(bytes: Uint8Array, sampleLen: number): Uint8Array {
  if (sampleLen <= 0) {
    return bytes.subarray(0, 0);
  }

  let end = sampleLen;
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) {
    end--;
  }
  if (end === 0) {
    return bytes.subarray(0, 0);
  }

  const leadIndex = end - 1;
  const lead = bytes[leadIndex]!;
  if (lead < 0x80) {
    return bytes.subarray(0, sampleLen);
  }
  if (lead < 0xc0) {
    return bytes.subarray(0, leadIndex);
  }

  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  if (sampleLen - leadIndex >= need) {
    return bytes.subarray(0, sampleLen);
  }
  return bytes.subarray(0, leadIndex);
}

function isUnicodeTextCodePoint(cp: number): boolean {
  if (cp === 9 || cp === 10 || cp === 13) {
    return true;
  }
  // C0 controls + DEL
  if (cp < 32 || cp === 0x7f) {
    return false;
  }
  // C1 controls
  if (cp >= 0x80 && cp <= 0x9f) {
    return false;
  }
  return true;
}

function isMostlyUtf8Text(bytes: Uint8Array, sampleLen: number): boolean {
  const sample = truncateToCompleteUtf8(bytes, sampleLen);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  const chars = Array.from(text);
  if (chars.length === 0) {
    return false;
  }
  let good = 0;
  for (const ch of chars) {
    if (isUnicodeTextCodePoint(ch.codePointAt(0)!)) {
      good++;
    }
  }
  return good / chars.length >= TEXT_PRINTABLE_RATIO;
}

function contentMatchesDeclaredMime(mimeType: string, kind: AttachmentContentKind): boolean {
  const expected = MIME_TO_EXPECTED_KIND[mimeType];
  if (!expected) {
    return false;
  }

  if (expected === "text-family") {
    // Text family accepts only printable text. Reject scripts/executables,
    // known binaries, and unknown (null-byte / non-printable) content so
    // binaries cannot bypass via text/plain spoofing.
    return kind === "text";
  }

  return kind === expected;
}

/**
 * Validate attachment filename + MIME against the chat allowlist / denylist.
 * Used for URL-only attachments where bytes are not available for magic sniff.
 */
export function validateChatAttachmentMetadata(input: {
  filename: string;
  mimeType: string;
}): AttachmentValidationResult {
  const mime = (input.mimeType || "").toLowerCase().trim();
  const resolvedFilename = resolveAttachmentFilename(input.filename, mime);
  const safeName = sanitizeAttachmentFilename(resolvedFilename);
  if (!safeName) {
    return {
      ok: false,
      failure: {
        message: `Invalid attachment filename: ${input.filename}`,
        status: 400,
        code: "ATTACHMENT_TYPE_NOT_ALLOWED",
      },
    };
  }

  const ext = extensionOfFilename(safeName);

  if (!ext || CHAT_DENIED_EXTENSIONS.has(ext) || !CHAT_ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      failure: {
        message: `File type not allowed: ${safeName}`,
        status: 400,
        code: "ATTACHMENT_TYPE_NOT_ALLOWED",
      },
    };
  }

  if (!mime || CHAT_DENIED_MIME_TYPES.has(mime) || !CHAT_ALLOWED_MIME_TYPES.has(mime)) {
    return {
      ok: false,
      failure: {
        message: `File type not allowed: ${safeName}`,
        status: 400,
        code: "ATTACHMENT_TYPE_NOT_ALLOWED",
      },
    };
  }

  return { ok: true, safeName, mimeType: mime };
}

/**
 * Validate a single chat attachment (filename, MIME, size, magic bytes).
 */
export function validateChatAttachment(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  maxBytes: number;
}): AttachmentValidationResult {
  const meta = validateChatAttachmentMetadata({
    filename: input.filename,
    mimeType: input.mimeType,
  });
  if (!meta.ok) {
    return meta;
  }

  const { safeName, mimeType: mime } = meta;

  if (input.bytes.byteLength > input.maxBytes) {
    const mb = (input.maxBytes / (1024 * 1024)).toFixed(0);
    const actual = (input.bytes.byteLength / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      failure: {
        message: `File "${safeName}" is ${actual}MB. Maximum file size is ${mb}MB.`,
        status: 413,
        code: "ATTACHMENT_TOO_LARGE",
      },
    };
  }

  const kind = sniffAttachmentContent(input.bytes);
  if (!contentMatchesDeclaredMime(mime, kind)) {
    return {
      ok: false,
      failure: {
        message: `Content does not match declared type for "${safeName}"`,
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
      },
    };
  }

  return { ok: true, safeName, mimeType: mime };
}

/**
 * Decode a data-URL or raw base64 payload to bytes. Returns null on failure.
 *
 * ## Why this validates instead of trusting the decoder to throw
 *
 * `Buffer.from(s, "base64")` **never throws and never reports failure**: it
 * silently skips every character outside the base64 alphabet and returns
 * whatever the survivors decoded to. So `"!!!!"` came back as zero bytes and
 * `"not base64 at all!!!"` came back as ten bytes of garbage — both of which
 * this function used to return as a successful decode, because the only way it
 * could fail was a `throw` that could not happen.
 *
 * Every caller has a `null` branch that was therefore dead code: the two
 * inbound attachment paths raised `ATTACHMENT_TYPE_NOT_ALLOWED` /
 * "invalid encoding" that no input could reach, and
 * `classifyArtifactFilePart`'s `undecodable` rejection reason — a documented
 * member of the public `RunArtifactFileRejection` union — could never fire. An
 * agent's garbage `raw` under an allowlisted text type was accepted, stored,
 * and published as a working `FilePart` URL holding nothing. The fix belongs here rather than at any one call site precisely
 * because all three shared the hole.
 *
 * The test is a canonical round-trip, not a regex alone: re-encoding the
 * decoded bytes must reproduce the input. That catches what the alphabet check
 * cannot — a length that encodes no whole byte (`"a"`), and trailing bits a
 * real encoder never sets (`"aa=="` decodes as `"aQ=="` does).
 *
 * Two variances a conformant producer may legitimately emit are normalised
 * rather than refused, since the A2A surface is public and a non-NovaOS peer is
 * not bound by NovaOS's own encoder: MIME line-wrapping whitespace, and the
 * base64url alphabet (`-`/`_`) that protobuf JSON permits for `bytes` fields.
 * Padding is optional in both directions.
 */
export function decodeAttachmentData(data: string): Uint8Array | null {
  const base64Part = data.includes(",") ? data.split(",")[1]! : data;
  // Whitespace is stripped before anything else so a line-wrapped payload is
  // measured and compared as the single token it represents.
  const compact = base64Part.replace(/[\r\n\t ]/g, "");
  // Empty base64 segment (e.g. data:text/plain;base64,) is a valid empty file —
  // do not treat as invalid encoding; sniff/validateChatAttachment accept empty text.
  if (compact.length === 0) {
    return new Uint8Array();
  }
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }
  const bytes = Uint8Array.from(Buffer.from(normalized, "base64"));
  const unpadded = normalized.replace(/=+$/, "");
  if (Buffer.from(bytes).toString("base64").replace(/=+$/, "") !== unpadded) {
    return null;
  }
  return bytes;
}

/** Failure for attachment count over the per-request cap. */
export function attachmentCountExceededFailure(
  count: number,
  max: number = DEFAULT_MAX_ATTACHMENTS_PER_REQUEST
): AttachmentValidationFailure {
  return {
    message: `Too many files. Maximum ${max} files allowed (received ${count}).`,
    status: 400,
    code: "ATTACHMENT_LIMIT_EXCEEDED",
  };
}

export interface AttachmentUploadRateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
  readonly limit: number;
}

export interface AttachmentUploadRateLimiter {
  check(key: string): AttachmentUploadRateLimitResult;
  clear(): void;
  destroy(): void;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter for chat attachment uploads.
 * Bounded Map with eviction — safe for long-lived BFF workers.
 */
export function createAttachmentUploadRateLimiter(opts?: {
  maxPerWindow?: number;
  windowMs?: number;
  maxKeys?: number;
}): AttachmentUploadRateLimiter {
  const maxPerWindow = opts?.maxPerWindow ?? CHAT_ATTACHMENT_UPLOAD_MAX_PER_WINDOW;
  const windowMs = opts?.windowMs ?? CHAT_ATTACHMENT_UPLOAD_WINDOW_MS;
  const maxKeys = opts?.maxKeys ?? CHAT_ATTACHMENT_UPLOAD_RATE_LIMIT_MAX_KEYS;
  const buckets = new Map<string, RateBucket>();
  let destroyed = false;

  const cleanupExpired = (now: number): void => {
    for (const [k, entry] of buckets) {
      if (entry.resetAt <= now) {
        buckets.delete(k);
      }
    }
  };

  return {
    check(key: string): AttachmentUploadRateLimitResult {
      if (destroyed) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: Date.now() + windowMs,
          retryAfterSeconds: Math.ceil(windowMs / 1000),
          limit: maxPerWindow,
        };
      }
      const now = Date.now();
      cleanupExpired(now);
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) {
            buckets.delete(oldest);
          }
        }
        const resetAt = now + windowMs;
        buckets.set(key, { count: 1, resetAt });
        return {
          allowed: true,
          remaining: maxPerWindow - 1,
          resetAt,
          retryAfterSeconds: Math.ceil(windowMs / 1000),
          limit: maxPerWindow,
        };
      }
      existing.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      if (existing.count > maxPerWindow) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: existing.resetAt,
          retryAfterSeconds,
          limit: maxPerWindow,
        };
      }
      return {
        allowed: true,
        remaining: maxPerWindow - existing.count,
        resetAt: existing.resetAt,
        retryAfterSeconds,
        limit: maxPerWindow,
      };
    },
    clear(): void {
      buckets.clear();
    },
    destroy(): void {
      destroyed = true;
      buckets.clear();
    },
  };
}
