/**
 * Kubernetes label *value* sanitization.
 *
 * Label values must match:
 *   (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?
 *
 * Display names from the agent catalog (e.g. "Browser Agent") are not safe
 * to use verbatim. Pod names were already sanitized; labels were not, and
 * unsanitized values made the Kubernetes API reject pod creation with a 422.
 */

/** Maximum length for a Kubernetes label value. */
export const K8S_LABEL_VALUE_MAX_LENGTH = 63;

const K8S_LABEL_VALUE_PATTERN = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

/**
 * Sanitize a string for use as a Kubernetes label value.
 *
 * - Replaces invalid characters with `-`
 * - Trims leading/trailing non-alphanumeric characters
 * - Truncates to `maxLength` (default 63)
 * - Returns `fallback` when the result would be empty
 */
export function sanitizeK8sLabelValue(
  value: string,
  maxLength: number = K8S_LABEL_VALUE_MAX_LENGTH,
  fallback = "unknown"
): string {
  if (!value || !value.trim()) {
    return fallback;
  }

  const truncated = value.slice(0, maxLength);
  let sanitized = truncated.replace(/[^A-Za-z0-9._-]/g, "-");
  sanitized = sanitized.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");

  if (!sanitized || !K8S_LABEL_VALUE_PATTERN.test(sanitized)) {
    return fallback;
  }

  return sanitized.slice(0, maxLength);
}

/** Returns true when `value` is a valid Kubernetes label value. */
export function isValidK8sLabelValue(value: string): boolean {
  return value.length <= K8S_LABEL_VALUE_MAX_LENGTH && K8S_LABEL_VALUE_PATTERN.test(value);
}
