/**
 * novaos-cli — Unified Test Runner
 *
 * Discovers and runs tests for NovaOS agent projects.
 * Detects project language (TypeScript/Python) and invokes the appropriate runner.
 * Optionally starts the sandbox before running tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const TS_TEST_PATTERNS = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];
const PY_TEST_PATTERNS = ["test_", "_test.py"];
const SEARCH_DEPTH = 4;
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__", ".venv", "venv"]);

export interface TestRunnerOptions {
  pattern?: string;
  sandbox?: boolean;
  /** If true with sandbox: run `novaos-cli sandbox stop` when this run started the stack. */
  stopSandboxAfter?: boolean;
  verbose?: boolean;
  watch?: boolean;
  cwd?: string;
}

interface DiscoveredTests {
  language: "typescript" | "python" | "unknown";
  files: string[];
}

function isTestFile(filename: string): "typescript" | "python" | null {
  for (const pattern of TS_TEST_PATTERNS) {
    if (filename.endsWith(pattern)) return "typescript";
  }
  for (const pattern of PY_TEST_PATTERNS) {
    if (filename.startsWith(pattern) || filename.endsWith("_test.py")) return "python";
  }
  if (filename.endsWith(".test.py")) return "python";
  return null;
}

function discoverTestFiles(rootDir: string, glob?: string, depth = 0): DiscoveredTests {
  const files: string[] = [];
  let language: "typescript" | "python" | "unknown" = "unknown";

  function walk(dir: string, currentDepth: number): void {
    if (currentDepth > SEARCH_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, currentDepth + 1);
      } else if (stat.isFile()) {
        if (glob && !fullPath.includes(glob)) continue;
        const lang = isTestFile(entry);
        if (lang) {
          files.push(fullPath);
          if (language === "unknown") language = lang;
        }
      }
    }
  }

  walk(rootDir, depth);
  return { language, files };
}

export function detectPackageManager(cwd: string): "bun" | "npm" | "yarn" {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return "npm";
}

export async function runTests(options: TestRunnerOptions): Promise<{ exitCode: number }> {
  const cwd = resolve(options.cwd ?? process.cwd());

  process.stderr.write("Discovering test files...\n");
  const discovered = discoverTestFiles(cwd, options.pattern);

  if (discovered.files.length === 0) {
    process.stderr.write("No test files found.\n");
    if (options.pattern) {
      process.stderr.write(`  Pattern: ${options.pattern}\n`);
    }
    process.stderr.write("  Searched for: *.test.ts, *.spec.ts, test_*.py, *_test.py\n");
    return { exitCode: 1 };
  }

  process.stderr.write(`Found ${discovered.files.length} test file(s) (${discovered.language})\n`);

  let startedSandboxHere = false;
  if (options.sandbox) {
    const { sandboxStart, isSandboxServicesRunning } = await import("./sandbox.js");
    if (!isSandboxServicesRunning()) {
      process.stderr.write("Starting sandbox...\n");
      try {
        await sandboxStart();
        startedSandboxHere = true;
      } catch (err) {
        process.stderr.write(
          `Error: Failed to start sandbox: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.stderr.write("Cannot run tests with --sandbox when sandbox fails to start.\n");
        return { exitCode: 1 };
      }
    } else {
      process.stderr.write("Sandbox already running.\n");
    }
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (options.sandbox) {
    env.NOVAOS_ENV = "sandbox";
  }

  let command: string;
  let args: string[];

  if (discovered.language === "typescript") {
    const pm = detectPackageManager(cwd);
    command = pm === "bun" ? "bun" : pm;
    args = ["test"];
    if (options.pattern) args.push(options.pattern);
    if (options.verbose) args.push("--verbose");
    if (options.watch) args.push("--watch");
  } else if (discovered.language === "python") {
    command = "python3";
    args = ["-m", "pytest"];
    if (options.pattern) args.push("-k", options.pattern);
    if (options.verbose) args.push("-v");
    if (options.watch) args.push("--looponfail");
  } else {
    process.stderr.write("Could not determine test runner for discovered files.\n");
    return { exitCode: 1 };
  }

  process.stderr.write(`\nRunning: ${command} ${args.join(" ")}\n\n`);

  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });

  if (options.sandbox && options.stopSandboxAfter && startedSandboxHere) {
    try {
      const { sandboxStop } = await import("./sandbox.js");
      await sandboxStop({ removeVolumes: false });
      process.stderr.write("Sandbox stopped (--stop-sandbox-after).\n");
    } catch (err) {
      process.stderr.write(
        `Warning: failed to stop sandbox: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  return { exitCode: result.status ?? 1 };
}
