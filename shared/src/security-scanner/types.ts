/**
 * Shared types for the security scanning pipeline.
 *
 * These types are consumed by:
 * - Backend: mcp-ops, agent-ops, review-service (produce scan reports)
 * - Frontend: validation-report.tsx (render scan reports in admin UI)
 *
 * The ScanReport shape must stay in sync with the SCAN_SECTIONS array in
 * packages/marketplace/app/src/components/developer/validation-report.tsx
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  findings: string[];
  details?: Record<string, unknown>;
}

export interface ScanReport {
  dependency_audit: CheckResult;
  image_scan: CheckResult;
  static_analysis: CheckResult;
  base_image_verification: CheckResult;
  manifest_validation: CheckResult;
}

/**
 * Overall scan verdict:
 * - "pass": every check ran and none failed.
 * - "fail": at least one check failed (publish must be rejected).
 * - "incomplete": nothing failed, but at least one check did not run
 *   (status "skipped"). This is NOT a clean bill of health — the artifact
 *   must go to manual review and must never be auto-approved.
 */
export type ScanVerdict = "pass" | "fail" | "incomplete";

export interface ScanOutcome {
  /**
   * True when no check failed. Does NOT mean every check ran — consult
   * `verdict` / `incomplete_checks` before treating the scan as clean.
   */
  passed: boolean;
  verdict: ScanVerdict;
  /** Report keys whose checks did not run (e.g. dependency_audit, image_scan). */
  incomplete_checks: Array<keyof ScanReport>;
  report: ScanReport;
  scanner: string;
  scanned_at: string;
}

export interface ManifestInput {
  name?: string;
  publisher?: string;
  version?: string;
  tools?: Array<{ name: string; description?: string; [k: string]: unknown }>;
  base_image?: string;
  health_check?: { path?: string; interval_seconds?: number };
  categories?: string[];
  permissions?: {
    network_egress?: string[];
    tools?: string[];
    [k: string]: unknown;
  };
  resources?: {
    max_memory_mb?: number;
    max_cpu_millicores?: number;
    max_replicas?: number;
    [k: string]: unknown;
  };
  url?: string;
  [k: string]: unknown;
}

export interface ScanContext {
  manifest: ManifestInput;
  imageRef?: string | null;
  publisher?: string;
  artifactType: "agent" | "mcp_tool";
}
