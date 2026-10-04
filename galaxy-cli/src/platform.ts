/**
 * Docker build platform resolution for novaos-cli publish commands.
 *
 * Priority:
 *   1. Explicit --platform flag (always wins)
 *   2. Auto-detect from host arch ONLY when targeting the local environment —
 *      local Kind clusters mirror the host arch (linux/arm64 on Apple Silicon).
 *   3. linux/amd64 default — safe for all remote envs (dev/staging/production
 *      run on GCP amd64 nodes regardless of the developer's host machine).
 */

import os from "node:os";

export function resolveTargetPlatform(platformOverride?: string, envName?: string): string {
  if (platformOverride) return platformOverride;
  if (envName === "local" && os.arch() === "arm64") return "linux/arm64";
  return "linux/amd64";
}
