import type { CheckResult, ManifestInput } from "./types.js";

// Exported so the manifest schema's parity test (packages/galaxy-cli) can assert
// this classification stays in sync with the tool enum in manifest.ts, rather
// than the two lists drifting independently. "shell"/"exec"/"fs" are not valid
// manifest.ts enum values (they predate it / guard against future additions);
// every value that IS in the manifest enum must have an explicit decision here.
export const SENSITIVE_TOOL_PERMISSIONS = new Set([
  "http",
  "browser",
  "code",
  "shell",
  "exec",
  "fs",
  "connectors",
]);
const HIGH_MEMORY_THRESHOLD_MB = 2048;
const HIGH_CPU_THRESHOLD_MILLICORES = 2000;

/**
 * Lightweight static analysis of an agent/tool manifest.
 *
 * Checks for:
 * - Wildcard network_egress permissions
 * - Wildcard tool permissions
 * - Use of sensitive tool categories (http, browser, code, shell)
 * - Excessive resource requests that may indicate abuse
 */
export function analyzePermissions(manifest: ManifestInput): CheckResult {
  const findings: string[] = [];
  const permissions = manifest.permissions;

  if (permissions) {
    if (Array.isArray(permissions.network_egress)) {
      if (permissions.network_egress.includes("*")) {
        findings.push(
          'Wildcard network_egress ["*"] grants unrestricted outbound network access. Declare specific domains instead.'
        );
      }
    }

    if (Array.isArray(permissions.tools)) {
      if (permissions.tools.includes("*")) {
        findings.push(
          'Wildcard tools permission ["*"] grants access to all tool categories. Declare specific categories instead.'
        );
      }

      const sensitiveUsed = permissions.tools.filter((t) =>
        SENSITIVE_TOOL_PERMISSIONS.has(t.toLowerCase())
      );
      if (sensitiveUsed.length > 0) {
        findings.push(
          `Sensitive tool permissions declared: [${sensitiveUsed.join(", ")}]. These require manual review.`
        );
      }
    }
  }

  const resources = manifest.resources;
  if (resources) {
    if (
      typeof resources.max_memory_mb === "number" &&
      resources.max_memory_mb > HIGH_MEMORY_THRESHOLD_MB
    ) {
      findings.push(
        `High memory request (${resources.max_memory_mb}MB) exceeds ${HIGH_MEMORY_THRESHOLD_MB}MB threshold. Verify this is justified.`
      );
    }
    if (
      typeof resources.max_cpu_millicores === "number" &&
      resources.max_cpu_millicores > HIGH_CPU_THRESHOLD_MILLICORES
    ) {
      findings.push(
        `High CPU request (${resources.max_cpu_millicores}m) exceeds ${HIGH_CPU_THRESHOLD_MILLICORES}m threshold. Verify this is justified.`
      );
    }
  }

  if (findings.length === 0) {
    return {
      status: "pass",
      findings: [],
      details: { checks_run: "network_egress, tool_permissions, resource_thresholds" },
    };
  }

  const hasCritical = findings.some(
    (f) => f.includes("Wildcard network_egress") || f.includes("Wildcard tools permission")
  );

  return {
    status: hasCritical ? "warn" : "warn",
    findings,
    details: { checks_run: "network_egress, tool_permissions, resource_thresholds" },
  };
}
