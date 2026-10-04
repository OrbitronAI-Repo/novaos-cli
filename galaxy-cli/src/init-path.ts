/**
 * Shared path / slug guards for galaxy-cli init commands (agent, MCP, connector).
 *
 * Relates to: 86exrbhjy — path-like --name values must point users at --dir;
 * relative ".." directories stay rejected (absolute paths remain the supported escape hatch).
 */

/** True when the value looks like a filesystem path rather than a DNS-style slug. */
export function looksLikeFilesystemPath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

/**
 * Reject path-like --name values with guidance to use --dir.
 * Does not enforce DNS slug format — callers that need that keep their own check.
 */
export function assertNameIsNotPath(kind: string, name: string): void {
  if (!looksLikeFilesystemPath(name)) {
    return;
  }
  throw new Error(
    `Invalid ${kind} name "${name}". ` +
      `It looks like a filesystem path. Use --name for the DNS-compatible slug ` +
      `and --dir for the output location (absolute paths are supported). ` +
      `Example: --name my-${kind} --dir /absolute/path/to/my-${kind}`
  );
}

/**
 * Reject directories containing ".." (path traversal).
 * Absolute paths without ".." are allowed.
 */
export function assertNoPathTraversal(
  rawDir: string,
  label: "Directory" | "Output directory" = "Directory"
): void {
  if (!rawDir.includes("..")) {
    return;
  }
  throw new Error(
    `${label} "${rawDir}" contains path traversal component (".."). ` +
      "Relative paths with .. are not allowed. Use an absolute path instead " +
      "(for example --dir /Users/you/projects/my-project)."
  );
}
