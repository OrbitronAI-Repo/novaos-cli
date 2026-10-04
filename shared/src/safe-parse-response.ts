/**
 * Runtime-safe JSON parsing for upstream HTTP responses.
 *
 * Replaces `(await response.json()) as T` with a validated parse that:
 *  1. Catches JSON parse failures
 *  2. Validates required fields exist at runtime
 *  3. Returns a typed result with explicit null for missing data
 *
 * For full schema validation, use Zod. This is a lightweight guard
 * for internal service-to-service calls where the contract is controlled.
 */

/**
 * Parse a Response's JSON body and validate that required top-level keys exist.
 * Throws if the body is not valid JSON or if any required key is missing.
 */
export async function parseUpstreamJson<T extends Record<string, unknown>>(
  response: Response,
  requiredKeys: (keyof T)[] = [],
  context?: string
): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(
      `${context ?? "Upstream"}: response body is not valid JSON (HTTP ${response.status})`
    );
  }

  if (json === null || typeof json !== "object") {
    throw new Error(
      `${context ?? "Upstream"}: expected JSON object, got ${json === null ? "null" : typeof json}`
    );
  }

  const obj = json as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (!(key in obj) || obj[key as string] === undefined) {
      throw new Error(
        `${context ?? "Upstream"}: missing required field "${String(key)}" in response`
      );
    }
  }

  return obj as T;
}

/**
 * Parse a Response's JSON body, extract `.data`, and validate it is non-null.
 * Common pattern for internal services that wrap payloads as `{ data: T }`.
 */
export async function parseUpstreamData<T>(response: Response, context?: string): Promise<T> {
  const json = await parseUpstreamJson<{ data: T }>(response, ["data"], context);
  if (json.data === null || json.data === undefined) {
    throw new Error(`${context ?? "Upstream"}: .data field is null`);
  }
  return json.data;
}
