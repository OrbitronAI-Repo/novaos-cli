/**
 * Detects a Python agent whose requirements still install from TestPyPI.
 *
 * New agents install `novaos-agent-sdk` from public PyPI. Agents scaffolded
 * before the SDK was published there carry a `requirements-sdk.txt` that points
 * at TestPyPI, which has no uptime or retention guarantee and can be purged
 * without notice. `galaxy publish` uses this to warn about those agents, based
 * on the agent's own files rather than anything about the CLI.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Hostname that identifies TestPyPI. */
const TEST_PYPI_HOSTNAME = "test.pypi.org";

/** `--index-url`, `--extra-index-url` or `-i`, with a space or `=` before the URL. */
const INDEX_DIRECTIVE = /^\s*(?:--index-url|--extra-index-url|-i)(?:\s+|=)(\S+)/;

/**
 * Whether `indexUrl` is TestPyPI (or a subdomain of it).
 *
 * Compares the parsed hostname, not a substring of the raw URL — a substring
 * check would treat something like "https://pypi.org/?x=test.pypi.org" as
 * TestPyPI, and "https://test.pypi.org.attacker.example/" as a legitimate
 * subdomain of it (CodeQL: incomplete URL substring sanitization).
 */
export function isTestPyPiIndex(indexUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(indexUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === TEST_PYPI_HOSTNAME || hostname.endsWith(`.${TEST_PYPI_HOSTNAME}`);
}

/**
 * Names of the `requirements*.txt` files directly in `dir` that point pip at
 * TestPyPI. Returns an empty list when the directory cannot be read.
 */
export function testPyPiRequirementFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^requirements.*\.txt$/.test(name));
  } catch {
    return [];
  }
  return names.filter((name) => {
    let body: string;
    try {
      body = readFileSync(path.join(dir, name), "utf-8");
    } catch {
      return false;
    }
    return body.split("\n").some((line) => {
      const match = INDEX_DIRECTIVE.exec(line);
      return match !== null && isTestPyPiIndex(match[1]!);
    });
  });
}

/** One-line warning naming the files that install from TestPyPI. */
export function testPyPiWarning(files: string[]): string {
  return (
    `⚠ ${files.join(", ")} installs from TestPyPI, which has no uptime or retention ` +
    "guarantee — this agent is not production-deployable. Install novaos-agent-sdk " +
    'from PyPI instead (for example "novaos-agent-sdk>=2.1,<3" in requirements.txt).\n'
  );
}
