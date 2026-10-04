/**
 * Agent adapter selector predicates.
 *
 * The catalog/installation adapter-selector value picks which adapter
 * `adapter-router.ts` routes a run through; it does not name a wire protocol
 * (that's A2A). `"A2A"` is the canonical value; keeping the stored value as
 * `"ACP"` would have been misleading, since the adapter speaks A2A. `"ACP"`
 * is a deprecated legacy alias: still accepted here because agents in the
 * fleet may not yet publish `"A2A"` (the tolerance can be removed once they
 * all do). Use these predicates — never a literal
 * `=== "ACP"` or `=== "A2A"` comparison — so a mangled-case value
 * (`"acp"`) is treated consistently everywhere; before they existed,
 * the dispatcher's case-sensitive check and the execution route's
 * case-sensitive `!== "REST"` check disagreed about what a lowercase row
 * meant, silently downgrading it from Temporal to direct dispatch.
 *
 * This module is intentionally side-effect-free and imports nothing at
 * module level, so it is safe to import into browser-bundled code
 * (the shared utils module pulls in "crypto" and DNS resolution at module
 * scope and is not).
 */

export function isSdkAdapter(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().toUpperCase();
  return v === "ACP" || v === "A2A";
}

/** The `"REST"` counterpart to {@link isSdkAdapter} — see the module doc comment. */
export function isRestAdapter(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().toUpperCase() === "REST";
}
