import type { CheckResult, ManifestInput } from "./types.js";

const PLATFORM_MAX_MEMORY_MB = 4096;
const PLATFORM_MAX_CPU_MILLICORES = 4000;
const PLATFORM_MAX_REPLICAS = 10;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const PUBLISHER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export function validateManifest(
  manifest: ManifestInput,
  artifactType: "agent" | "mcp_tool"
): CheckResult {
  const findings: string[] = [];

  if (!manifest.name || typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
    findings.push("manifest.name is missing or empty");
  }

  if (!manifest.version || typeof manifest.version !== "string") {
    findings.push("manifest.version is missing or empty");
  }

  if (manifest.publisher && !PUBLISHER_NAME_PATTERN.test(manifest.publisher)) {
    findings.push(
      `manifest.publisher "${manifest.publisher}" does not match pattern: lowercase alphanumeric with hyphens, starting with a letter`
    );
  }

  if (artifactType === "mcp_tool") {
    if (!manifest.tools || !Array.isArray(manifest.tools) || manifest.tools.length === 0) {
      findings.push("MCP tool manifest must declare at least one tool in the tools array");
    } else {
      for (const tool of manifest.tools) {
        if (!tool.name || typeof tool.name !== "string") {
          findings.push("Each tool must have a non-empty name");
        } else if (!TOOL_NAME_PATTERN.test(tool.name)) {
          findings.push(
            `Tool name "${tool.name}" does not match naming convention (lowercase alphanumeric, dots, underscores, colons, hyphens)`
          );
        }
      }
    }
  }

  const resources = manifest.resources;
  if (resources) {
    if (
      typeof resources.max_memory_mb === "number" &&
      resources.max_memory_mb > PLATFORM_MAX_MEMORY_MB
    ) {
      findings.push(
        `max_memory_mb (${resources.max_memory_mb}) exceeds platform maximum (${PLATFORM_MAX_MEMORY_MB})`
      );
    }
    if (
      typeof resources.max_cpu_millicores === "number" &&
      resources.max_cpu_millicores > PLATFORM_MAX_CPU_MILLICORES
    ) {
      findings.push(
        `max_cpu_millicores (${resources.max_cpu_millicores}) exceeds platform maximum (${PLATFORM_MAX_CPU_MILLICORES})`
      );
    }
    if (
      typeof resources.max_replicas === "number" &&
      resources.max_replicas > PLATFORM_MAX_REPLICAS
    ) {
      findings.push(
        `max_replicas (${resources.max_replicas}) exceeds platform maximum (${PLATFORM_MAX_REPLICAS})`
      );
    }
  }

  if (manifest.deployment_target !== undefined) {
    if (!Array.isArray(manifest.deployment_target)) {
      findings.push("manifest.deployment_target must be an array");
    } else if (manifest.deployment_target.length === 0) {
      findings.push("manifest.deployment_target must contain at least one value");
    } else {
      const validTargets = ["chat", "api"];
      for (const target of manifest.deployment_target) {
        if (typeof target !== "string" || !validTargets.includes(target)) {
          findings.push(
            `manifest.deployment_target contains invalid value "${target}" — allowed values: ${validTargets.join(", ")}`
          );
        }
      }
    }
  }

  if (artifactType === "mcp_tool" && manifest.url) {
    if (!manifest.health_check?.path) {
      findings.push(
        "MCP tools with a url should declare health_check.path for liveness monitoring"
      );
    }
  }

  if (findings.length === 0) {
    return {
      status: "pass",
      findings: [],
      details: { checks_run: "structure, naming, resource_limits" },
    };
  }

  const hasCritical = findings.some(
    (f) =>
      f.includes("is missing or empty") ||
      f.includes("must declare at least one tool") ||
      f.includes("exceeds platform maximum")
  );

  return {
    status: hasCritical ? "fail" : "warn",
    findings,
    details: { checks_run: "structure, naming, resource_limits" },
  };
}
