/**
 * novaos-cli — Local Agent Runner
 *
 * Provides `novaos-cli run` to start an agent process locally, poll its health
 * endpoint, send a test request, and print the response.
 *
 * Supports TypeScript (bun), Python (uvicorn), and Java (spring-boot) agents.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { extractA2AResponseText, sendA2AMessage } from "./a2a-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every `init` scaffold template listens on `SERVER_PORT`, defaulting to 8001. */
const DEFAULT_AGENT_PORT = 8001;
const HEALTH_CHECK_RETRIES = 15;
const HEALTH_CHECK_INTERVAL_MS = 2_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INPUT = "hello";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  port?: number;
  input?: string;
  sandbox?: boolean;
  /** If true with sandbox: run `novaos-cli sandbox stop` when this run started the stack (not if it was already up). */
  stopSandboxAfter?: boolean;
  trace?: boolean;
  cwd?: string;
  /** Override health-check retry behaviour (useful for testing). */
  healthCheck?: { retries?: number; intervalMs?: number; timeoutMs?: number };
}

type AgentLanguage = "typescript" | "python" | "java";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

export function detectAgentLanguage(dir: string): AgentLanguage | null {
  if (existsSync(join(dir, "package.json"))) return "typescript";
  if (existsSync(join(dir, "requirements.txt"))) return "python";
  if (existsSync(join(dir, "pom.xml"))) return "java";
  return null;
}

// ---------------------------------------------------------------------------
// Spawn args per language
// ---------------------------------------------------------------------------

export function buildSpawnArgs(
  language: AgentLanguage,
  port: number
): { command: string; args: string[] } {
  switch (language) {
    case "typescript":
      return { command: "bun", args: ["run", "start"] };
    case "python":
      return {
        command: "python3",
        args: ["-m", "uvicorn", "server:app", "--port", String(port)],
      };
    case "java":
      return {
        command: "./mvnw",
        args: ["spring-boot:run", `-Dserver.port=${port}`],
      };
  }
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

const BACKOFF_MULTIPLIER = 1.5;

export async function pollHealth(
  port: number,
  opts?: { retries?: number; intervalMs?: number; timeoutMs?: number }
): Promise<boolean> {
  const retries = opts?.retries ?? HEALTH_CHECK_RETRIES;
  const baseIntervalMs = opts?.intervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const timeoutMs = opts?.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const url = `http://localhost:${port}/health`;
  let delay = baseIntervalMs;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
    } catch {
      // agent not ready yet — retry with backoff
    }
    if (attempt < retries) {
      const jitteredDelay = delay * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jitteredDelay));
      delay = Math.min(delay * BACKOFF_MULTIPLIER, timeoutMs);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runAgent(options: RunAgentOptions): Promise<{ exitCode: number }> {
  const port = options.port ?? DEFAULT_AGENT_PORT;
  const cwd = resolve(options.cwd ?? process.cwd());
  const inputText = options.input ?? DEFAULT_INPUT;

  const language = detectAgentLanguage(cwd);
  if (!language) {
    process.stderr.write(
      "Could not detect agent language. Expected package.json (TS), requirements.txt (Python), or pom.xml (Java).\n"
    );
    return { exitCode: 1 };
  }

  process.stderr.write(`Detected language: ${language}\n`);

  let startedSandboxHere = false;
  if (options.sandbox) {
    try {
      const { sandboxStart, isSandboxServicesRunning } = await import("./sandbox.js");
      if (!isSandboxServicesRunning()) {
        process.stderr.write("Starting sandbox...\n");
        await sandboxStart();
        startedSandboxHere = true;
      } else {
        process.stderr.write("Sandbox already running; reusing.\n");
      }
    } catch (err) {
      process.stderr.write(
        `Failed to start sandbox: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return { exitCode: 1 };
    }
  }

  const maybeStopSandbox = async (): Promise<void> => {
    if (!options.sandbox || !options.stopSandboxAfter || !startedSandboxHere) return;
    try {
      const { sandboxStop } = await import("./sandbox.js");
      await sandboxStop({ removeVolumes: false });
      process.stderr.write("Sandbox stopped (--stop-sandbox-after).\n");
    } catch (err) {
      process.stderr.write(
        `Warning: failed to stop sandbox: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };

  const { command, args } = buildSpawnArgs(language, port);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.SERVER_PORT = String(port);
  if (options.sandbox) {
    env.NOVAOS_ENV = "sandbox";
  }

  process.stderr.write(`Spawning: ${command} ${args.join(" ")}\n`);

  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd, env, stdio: "inherit" });
  } catch (err) {
    process.stderr.write(
      `Failed to spawn agent process: ${err instanceof Error ? err.message : String(err)}\n`
    );
    await maybeStopSandbox();
    return { exitCode: 1 };
  }

  const cleanup = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  try {
    process.stderr.write(`Waiting for agent health on port ${port}...\n`);
    const healthy = await pollHealth(port, options.healthCheck);

    if (!healthy) {
      process.stderr.write(`Agent did not become healthy after ${HEALTH_CHECK_RETRIES} retries.\n`);
      return { exitCode: 1 };
    }

    process.stderr.write("Agent is healthy. Sending test request...\n");

    const result = await sendA2AMessage(`http://localhost:${port}`, inputText, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (result.transportError) {
      process.stderr.write(`Agent request failed: ${result.transportError}\n`);
      return { exitCode: 1 };
    }

    if (result.rpcError) {
      process.stderr.write(
        `Agent returned a JSON-RPC error ${result.rpcError.code}: ${result.rpcError.message}\n`
      );
      process.stdout.write(result.raw + "\n");
      return { exitCode: 1 };
    }

    if (result.body !== undefined) {
      process.stdout.write(JSON.stringify(result.body, null, 2) + "\n");
      const text = extractA2AResponseText(result.body);
      if (text) {
        process.stderr.write(`Agent response text: ${text}\n`);
      }
    } else {
      process.stdout.write(result.raw + "\n");
    }

    if (options.trace) {
      if (result.traceparent) {
        process.stderr.write(`Traceparent: ${result.traceparent}\n`);
      } else {
        process.stderr.write("No traceparent header in response.\n");
      }
    }

    return { exitCode: 0 };
  } catch (err) {
    process.stderr.write(`Run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  } finally {
    cleanup();
    await maybeStopSandbox();
  }
}
