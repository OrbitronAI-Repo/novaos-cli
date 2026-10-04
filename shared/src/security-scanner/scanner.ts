import { checkBaseImage } from "./base-image-checker.js";
import { validateManifest } from "./manifest-validator.js";
import { analyzePermissions } from "./permission-analyzer.js";
import type { CheckResult, ScanContext, ScanOutcome, ScanReport, ScanVerdict } from "./types.js";

const SCANNER_NAME = "novaos-platform-scanner";

/**
 * Run all in-process security scans against a publish artifact.
 *
 * Currently performs:
 * - manifest_validation: structural checks, naming, resource limits
 * - base_image_verification: allowlist + tag safety checks
 * - static_analysis: permission/resource abuse pattern detection
 *
 * Honestly marks as "skipped":
 * - dependency_audit: requires Trivy/npm-audit (future: K8s Job)
 * - image_scan: requires Trivy container scanning (future: K8s Job)
 *
 * Returns a ScanOutcome with `passed` determined by whether any section
 * has status "fail". Sections with "warn" do NOT block — they surface
 * findings in the admin UI for human review.
 *
 * `verdict` distinguishes a clean scan from one where checks did not run:
 * any "skipped" section yields verdict "incomplete", which
 * downstream review must route to manual approval, never auto-approve.
 */
export function runSecurityScan(ctx: ScanContext): ScanOutcome {
  const manifestResult = validateManifest(ctx.manifest, ctx.artifactType);
  const baseImageResult = checkBaseImage(ctx.imageRef);
  const staticAnalysisResult = analyzePermissions(ctx.manifest);

  const dependencyAudit: CheckResult = {
    status: "skipped",
    findings: [
      "Dependency vulnerability audit requires container image inspection (Trivy). Will be enabled when K8s Job scanning infrastructure is deployed.",
    ],
    details: { reason: "infrastructure_pending", scanner: "trivy" },
  };

  const imageScan: CheckResult = {
    status: "skipped",
    findings: [
      "Container image CVE scan requires Trivy. Will be enabled when K8s Job scanning infrastructure is deployed.",
    ],
    details: { reason: "infrastructure_pending", scanner: "trivy" },
  };

  const report: ScanReport = {
    manifest_validation: manifestResult,
    base_image_verification: baseImageResult,
    static_analysis: staticAnalysisResult,
    dependency_audit: dependencyAudit,
    image_scan: imageScan,
  };

  const passed = !hasFailing(report);
  const incompleteChecks = (Object.keys(report) as Array<keyof ScanReport>).filter(
    (key) => report[key].status === "skipped"
  );
  const verdict: ScanVerdict = !passed
    ? "fail"
    : incompleteChecks.length > 0
      ? "incomplete"
      : "pass";

  return {
    passed,
    verdict,
    incomplete_checks: incompleteChecks,
    report,
    scanner: SCANNER_NAME,
    scanned_at: new Date().toISOString(),
  };
}

function hasFailing(report: ScanReport): boolean {
  const sections: CheckResult[] = [
    report.manifest_validation,
    report.base_image_verification,
    report.static_analysis,
    report.dependency_audit,
    report.image_scan,
  ];
  return sections.some((s) => s.status === "fail");
}
