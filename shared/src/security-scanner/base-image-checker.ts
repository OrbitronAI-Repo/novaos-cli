import { APPROVED_BASE_IMAGES } from "./approved-images.js";
import type { CheckResult } from "./types.js";

const BLOCKED_TAG_PATTERNS = [":latest", ":nightly", ":unstable", ":edge"];

/**
 * Checks an image reference against the platform-approved base image allowlist.
 *
 * - Returns "pass" when the image is on the allowlist
 * - Returns "warn" when the image is off-list but not using a blocked tag
 * - Returns "fail" when the image uses a blocked tag pattern (:latest, etc.)
 * - Returns "skipped" when no image_ref is provided (manifest-only tools)
 */
export function checkBaseImage(imageRef: string | null | undefined): CheckResult {
  if (!imageRef) {
    return {
      status: "skipped",
      findings: ["No container image reference provided — base image check skipped"],
      details: { reason: "no_image_ref" },
    };
  }

  const findings: string[] = [];
  const normalizedRef = imageRef.toLowerCase();

  for (const blockedTag of BLOCKED_TAG_PATTERNS) {
    if (normalizedRef.endsWith(blockedTag)) {
      findings.push(
        `Image tag "${blockedTag}" is not allowed for production. Use a specific version tag or digest.`
      );
    }
  }

  if (!normalizedRef.includes(":") && !normalizedRef.includes("@sha256:")) {
    findings.push(
      "Image reference has no explicit tag or digest. This resolves to :latest at pull time, which is non-deterministic."
    );
  }

  const refWithoutDigest = normalizedRef.split("@")[0]!;
  const isApproved = APPROVED_BASE_IMAGES.some(
    (approved) =>
      refWithoutDigest === approved ||
      refWithoutDigest.startsWith(`${approved}:`) ||
      refWithoutDigest.startsWith(`${approved}-`)
  );

  if (!isApproved) {
    const imageBase = refWithoutDigest.split(":")[0]!;
    findings.push(
      `Image base "${imageBase}" is not on the platform-approved list. Approved images: ${APPROVED_BASE_IMAGES.join(", ")}`
    );
  }

  if (findings.length === 0) {
    return {
      status: "pass",
      findings: [],
      details: { image_ref: imageRef, on_allowlist: true },
    };
  }

  const hasBlocked = findings.some(
    (f) => f.includes("not allowed for production") || f.includes("no explicit tag")
  );

  return {
    status: hasBlocked ? "fail" : "warn",
    findings,
    details: { image_ref: imageRef, on_allowlist: isApproved },
  };
}
