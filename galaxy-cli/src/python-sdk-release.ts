/**
 * Python agent SDK — TestPyPI → production PyPI cutover gate.
 *
 * Python agents currently install `novaos-agent-sdk` from TestPyPI (see
 * PYTHON_AGENT_SDK_PACKAGE_INDEX_URL in ./constants.js), which has no
 * uptime/retention guarantee and can be purged without notice. This file
 * decides whether that pre-cutover index is still in effect, so callers
 * (`galaxy init`, `galaxy publish`) can surface it instead of silently
 * assuming TestPyPI is fine.
 *
 * The whole point of keying this off PYTHON_AGENT_SDK_PACKAGE_INDEX_URL is
 * that promoting the SDK to production PyPI is a single constant change in
 * ./constants.js — nothing here should need to change alongside it.
 */
import { PYTHON_AGENT_SDK_PACKAGE_INDEX_URL } from "./constants.js";

/**
 * Hostname fragment identifying TestPyPI. A derived pattern, not a second
 * copy of the full TestPyPI URL, so PYTHON_AGENT_SDK_PACKAGE_INDEX_URL stays
 * the single source of truth and this can't drift out of sync with it.
 */
const TEST_PYPI_HOSTNAME = "test.pypi.org";

export interface PythonSdkCutoverStatus {
  /** True while novaos-agent-sdk is still resolved from the pre-cutover TestPyPI index. */
  preCutover: boolean;
  /** The package index URL this status was computed from. */
  indexUrl: string;
}

/**
 * Whether `indexUrl` (default: the currently configured
 * PYTHON_AGENT_SDK_PACKAGE_INDEX_URL) is still TestPyPI rather than
 * production PyPI.
 *
 * Compares the parsed hostname, not a substring of the raw URL — a substring
 * check would treat something like "https://pypi.org/?x=test.pypi.org" as
 * TestPyPI, and "https://test.pypi.org.attacker.example/" as a legitimate
 * subdomain of it (CodeQL: incomplete URL substring sanitization).
 */
export function isPreCutoverIndex(indexUrl: string = PYTHON_AGENT_SDK_PACKAGE_INDEX_URL): boolean {
  let hostname: string;
  try {
    hostname = new URL(indexUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === TEST_PYPI_HOSTNAME || hostname.endsWith(`.${TEST_PYPI_HOSTNAME}`);
}

/** Structured form of `isPreCutoverIndex`, for callers that want to report on it, not just branch on it. */
export function pythonSdkCutoverStatus(
  indexUrl: string = PYTHON_AGENT_SDK_PACKAGE_INDEX_URL
): PythonSdkCutoverStatus {
  return { preCutover: isPreCutoverIndex(indexUrl), indexUrl };
}

/**
 * Prominent, single-line warning for a Python agent still pointed at the
 * pre-cutover index. Written to stderr by `galaxy init --lang python` (a
 * one-time heads-up at scaffold time) and `galaxy publish` (every time, since
 * the underlying condition can change between init and publish).
 */
export const PYTHON_SDK_PRE_CUTOVER_WARNING =
  "⚠ novaos-agent-sdk is installed from TestPyPI, which has no uptime or retention " +
  "guarantee — this agent is not production-deployable until the SDK is promoted to " +
  "production PyPI.\n";
