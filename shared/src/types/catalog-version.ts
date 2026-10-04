/**
 * The catalog version an install pin selects, for an exact-version catalog
 * lookup — or `undefined`, meaning "the newest row".
 *
 * An unset, blank or `"latest"` pin (case-insensitive) is not a version: it
 * follows whatever was published last. Anything else is trimmed and used as
 * is. Shared so the gateway, when it pins its own catalog reads and when it
 * hands a version to a workflow, and the Temporal worker's `resolveAgent`,
 * when it reads the row that version names, agree on what a pin means.
 */
export function catalogVersionForInstallPin(pin: string | null | undefined): string | undefined {
  const trimmed = pin != null ? String(pin).trim() : "";
  if (trimmed === "" || trimmed.toLowerCase() === "latest") return undefined;
  return trimmed;
}
