/**
 * novaos-cli — Agent Publish Command
 *
 * `novaos-cli publish <manifest-path> [--dockerfile <path>] [--dry-run] [--json]`
 *
 * Two HTTP roundtrips to Agent OPS:
 *   1. POST /publish/auth — validates, returns registry token + image_ref
 *   2. POST /publish      — finalizes review record after image push
 *
 * Between roundtrips: docker build + docker push (streamed to stderr).
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";

import {
  AGENT_CARD_MANIFEST_KEY,
  AgentSkillSchema,
  buildAgentCard,
  deriveDeclaredSkillIds,
  slugify,
  type AgentSkill,
} from "@novaos-cli/shared/a2a";
import semver from "semver";
import { z } from "zod";

import { REGISTRY_MAP } from "./constants.js";
import { envForIsolatedDockerConfig } from "./docker-daemon-env.js";
import { type GalaxyHttpClient, extractErrorDetail, withRequestId } from "./http-client.js";
import { validateManifest } from "./manifest.js";
import { resolveTargetPlatform } from "./platform.js";
import { isPreCutoverIndex, PYTHON_SDK_PRE_CUTOVER_WARNING } from "./python-sdk-release.js";

export interface PublishOptions {
  manifestPath: string;
  dockerfile?: string;
  context?: string;
  dryRun?: boolean;
  json?: boolean;
  platform?: string;
  /** Resolved environment name — used to determine the default build platform. */
  envName?: string;
}

interface PublishAuthResponse {
  data: {
    registry_token: string | null;
    registry_auth_required: boolean;
    image_ref: string;
    expires_at: string;
    agent_uuid: string;
    latest_version: string | null;
  };
}

interface PublishFinalizeResponse {
  data: {
    review_id: string;
    status: string;
    agent_uuid: string;
    version: string;
    image_ref: string;
  };
}

function stderr(msg: string): void {
  process.stderr.write(msg);
}

function ensureDocker(): void {
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    throw new Error(
      "Docker is required for novaos-cli publish. Start Docker Desktop or the Docker daemon.\n" +
        "If Docker is installed but not in PATH, set the DOCKER_HOST environment variable."
    );
  }
}

function resolveDockerfile(manifestPath: string, dockerfileOverride?: string): string {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const dockerfile = dockerfileOverride ?? path.join(manifestDir, "Dockerfile");
  if (!existsSync(dockerfile)) {
    throw new Error(
      `Dockerfile not found at ${dockerfile}. Provide --dockerfile <path> if using a non-standard layout.`
    );
  }
  return dockerfile;
}

/**
 * Rewrites the registry host:port prefix of an image ref using NOVAOS_REGISTRY_MAP.
 * Format: "from=to" e.g. "kind-registry:5000=localhost:5001"
 * Returns the original ref unchanged when no mapping matches.
 */
function rewriteImageRef(imageRef: string): string {
  if (!REGISTRY_MAP) return imageRef;
  if (process.env.CI === "true") {
    throw new Error(
      "NOVAOS_REGISTRY_MAP is not allowed in CI environments. " +
        "Remove the NOVAOS_REGISTRY_MAP env var or unset CI."
    );
  }
  const eqIdx = REGISTRY_MAP.indexOf("=");
  if (eqIdx <= 0) return imageRef;
  const from = REGISTRY_MAP.slice(0, eqIdx);
  const to = REGISTRY_MAP.slice(eqIdx + 1);
  if (!imageRef.startsWith(from)) return imageRef;
  process.stderr.write(
    `WARNING: NOVAOS_REGISTRY_MAP is active. Image push target redirected: ${from} → ${to}. ` +
      "This should only be used for local development.\n"
  );
  return to + imageRef.slice(from.length);
}

function dockerBuild(
  imageRef: string,
  dockerfile: string,
  contextDir: string,
  platform: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        platform,
        "--load",
        "-t",
        imageRef,
        "-f",
        dockerfile,
        contextDir,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    proc.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Docker build failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Docker build error: ${err.message}`));
    });
  });
}

function dockerPush(imageRef: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["push", imageRef], {
      stdio: ["ignore", "pipe", "inherit"],
      ...(env ? { env } : {}),
    });

    proc.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Docker push failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Docker push error: ${err.message}`));
    });
  });
}

/**
 * Pushes an image using an isolated Docker config that holds only the provided
 * oauth2accesstoken credential for the target registry.
 *
 * This bypasses any system credential helpers (e.g. gcloud auth docker-helper)
 * that may be configured in the user's ~/.docker/config.json. Those helpers
 * take priority over stored `auths` entries even after `docker login`, so the
 * only reliable way to use a server-vended token is to supply a clean config
 * via the DOCKER_CONFIG env var — the same approach used by crane, ko, and skopeo.
 */
function dockerPushWithToken(imageRef: string, registryHost: string, token: string): Promise<void> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "novaos-docker-"));
  const authValue = Buffer.from(`oauth2accesstoken:${token}`).toString("base64");
  const dockerConfig = { auths: { [registryHost]: { auth: authValue } } };
  writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(dockerConfig));

  return dockerPush(imageRef, envForIsolatedDockerConfig(tmpDir)).finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
}

/** Default `MODULE:ATTR` target, matching the Python scaffold template's `server.py`. */
const DEFAULT_AGENT_MODULE = "server:agent";

/** Where `captureRuntimeCard` got its `skills[]`/`capabilities` from. */
type CardCaptureSource = "image" | "host";

interface CardCapture {
  skills: AgentSkill[];
  capabilities: { streaming?: boolean };
  executedVia: CardCaptureSource;
}

/** Node's `os.arch()` values, mapped onto the `linux/<arch>` suffix `docker buildx --platform` uses. */
function hostDockerArch(): string {
  const arch = os.arch();
  if (arch === "x64") return "amd64";
  return arch;
}

/** The arch suffix of a `docker buildx --platform` value, e.g. `"linux/arm64"` -> `"arm64"`. */
function platformArch(platform: string): string {
  return platform.split("/")[1] ?? platform;
}

/**
 * Upper bound for the Agent Card emitter subprocess (image or host path).
 * Comfortably longer than the SDK's own `IMPORT_TIMEOUT_SECONDS` (30s)
 * internal guard against an unguarded `uvicorn.run()` — that guard should
 * always fire and report its own clear error first. This ceiling exists for
 * every *other* way the subprocess could hang and never reach that guard at
 * all: a stuck `docker run` (daemon/network issue), a target module that
 * blocks before the SDK's import machinery even runs. Without it,
 * `novaos-cli publish` would hang forever with no error after a successful
 * (and potentially slow, minutes-long) image build.
 *
 * Overridable via `NOVAOS_CLI_CAPTURE_TIMEOUT_MS` — mainly so tests can
 * exercise the timeout path in milliseconds instead of 45 real seconds,
 * though an operator with unusually slow image-startup latency could
 * legitimately need to raise it too. Read lazily (not baked into a
 * module-level constant) so the override still applies regardless of
 * when this module happened to be first imported in the process.
 */
function getCaptureTimeoutMs(): number {
  return Number(process.env.NOVAOS_CLI_CAPTURE_TIMEOUT_MS) || 45_000;
}

interface RunCapturingStdoutOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Called (in addition to killing the local `proc`) when the timeout fires.
   * Needed for `docker run`: SIGKILLing the client process only kills the
   * local CLI attached to it — the container itself keeps running on the
   * daemon (`--rm` cleans up on a normal exit, not a forcibly-killed client),
   * so a hung emitter would otherwise orphan a container that burns CPU until
   * someone finds and removes it by hand. Not needed for the host (`python3`)
   * path, where killing `proc` *is* killing the actual work.
   */
  onTimeout?: () => void;
}

/**
 * Runs `command` and resolves with its captured stdout, or rejects with its
 * stderr on a non-zero exit or on exceeding `timeoutMs` (default from
 * `getCaptureTimeoutMs()`). Distinct from `dockerBuild`/`dockerPush`, which
 * stream stdout straight to this process's stderr instead of capturing it —
 * the Agent Card emitter's contract is exactly one line of JSON
 * on stdout, which this process needs to read back, not just watch go by.
 */
function runCapturingStdout(
  command: string,
  args: string[],
  opts?: RunCapturingStdoutOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: opts.env } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      // reject() first: this rejection is the entire point of the timeout, so
      // it must not depend on cleanup succeeding or even returning. onTimeout
      // (docker kill on the image path) must itself be non-blocking — an
      // unresponsive daemon is exactly one of the cases this timeout exists
      // to survive, so a synchronous call here that could itself hang would
      // defeat it.
      reject(
        new Error(
          `${command} did not complete within ${(opts?.timeoutMs ?? getCaptureTimeoutMs()) / 1000}s`
        )
      );
      opts?.onTimeout?.();
    }, opts?.timeoutMs ?? getCaptureTimeoutMs());

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command} error: ${err.message}`));
    });
  });
}

/**
 * Raised when the Agent Card emitter fails specifically because
 * `novaos_client_sdk` isn't importable — the SDK is a normal pip dependency
 * now (installed from `requirements.txt`), so this means the environment the
 * emitter ran in hasn't had it installed, not a generic Agent Card capture
 * problem. Thrown separately from other capture failures so callers can
 * hard-fail on it with an actionable message instead of folding it into the
 * best-effort "card unavailable" path — but only for Python agents; the
 * emitter is Python-only, so this same failure is expected and non-fatal for
 * every other language, which never installs `novaos_client_sdk` at all.
 */
class SdkNotImportableError extends Error {}

/** Matches Python's own error text for a missing `novaos_client_sdk` import, across CPython versions. */
const SDK_IMPORT_FAILURE_PATTERN = /No module named ['"]novaos_client_sdk['"]/;

/**
 * Converts an Agent Card emitter failure caused by a missing SDK install into
 * one clear, actionable error instead of the raw Python import traceback text
 * the emitter subprocess produced. Every other emitter failure passes through
 * unchanged, so it still surfaces as before.
 */
function translateSdkImportFailure(err: Error): Error {
  if (!SDK_IMPORT_FAILURE_PATTERN.test(err.message)) return err;
  return new SdkNotImportableError(
    "novaos-agent-sdk is not installed or importable by the Agent Card emitter " +
      `(${err.message}). Run: pip install --no-deps -r requirements-sdk.txt && pip install -r requirements.txt`
  );
}

/** Resolve source imports independently of a potentially shared Docker build context. */
function hostCaptureEnv(contextDir: string, manifestDir: string): NodeJS.ProcessEnv {
  const sourcePaths = [
    path.join(manifestDir, "src"),
    manifestDir,
    path.join(contextDir, "vendor", "novaos-agent-client-sdk", "src"),
    path.join(contextDir, "sdk", "novaos-client-sdk", "src"),
  ];
  return {
    ...process.env,
    PYTHONPATH: [...sourcePaths, ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])].join(
      path.delimiter
    ),
  };
}

const RuntimeCardSchema = z.object({
  skills: z
    .array(AgentSkillSchema.extend({ id: z.string().min(1) }))
    .refine(
      (skills) => new Set(skills.map((skill) => skill.id)).size === skills.length,
      "Runtime skill ids must be unique"
    ),
  capabilities: z.object({ streaming: z.boolean() }),
});

/**
 * Runs the Agent Card emitter inside `localImageRef`, under a generated
 * `--name` so a timeout can actually stop the container.
 *
 * `docker run` (no `-d`) is a client attached to a container the daemon runs
 * independently: SIGKILLing the client only detaches it, and `--rm` cleans up
 * on the container's own normal exit, not on the client being killed out from
 * under it. Without a name to target, a hung emitter would keep running on
 * the daemon — consuming CPU — until an operator found and removed it by
 * hand. `docker kill` on timeout is the actual stop signal; it is
 * fire-and-forget (spawned, not awaited, and never allowed to throw) rather
 * than `execSync` — a *synchronous* cleanup call could itself hang against an
 * unresponsive daemon, which is exactly one of the cases the timeout this is
 * cleaning up after exists to survive, and would defeat it by blocking the
 * rejection that already fired.
 */
function runCaptureContainer(localImageRef: string, agentModule: string): Promise<string> {
  const containerName = `novaos-agent-card-capture-${process.pid}-${Date.now()}`;
  return runCapturingStdout(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "--entrypoint",
      "python",
      localImageRef,
      "-m",
      "novaos_client_sdk.agent_card",
      agentModule,
    ],
    {
      onTimeout: () => {
        try {
          spawn("docker", ["kill", containerName], { stdio: "ignore" }).unref();
        } catch {
          // best-effort cleanup only — see this function's docstring.
        }
      },
    }
  );
}

/**
 * Captures `skills[]` and `capabilities.streaming` from the agent's own
 * runtime, by running the SDK's `python -m
 * novaos_client_sdk.agent_card` emitter against the exact
 * `AgentBuilder` a live agent process would use.
 *
 * **Platform caveat.** The image was built with `--platform <targetPlatform>`
 * — arm64 on a Kind cluster on Apple Silicon, amd64 for every remote
 * environment. Running it via `docker run` when the host's own arch differs
 * would rely on QEMU emulation, which this command does not want to gate
 * publish latency (or reliability) on. Detected up front instead: on a match,
 * the emitter runs inside the image that was just built (the exact artifact
 * being published); on a mismatch, it falls back to running the emitter on
 * the host, against the source tree beside the manifest. The active Python
 * environment must provide the agent's dependencies.
 */
export async function captureRuntimeCard(
  localImageRef: string,
  contextDir: string,
  targetPlatform: string,
  agentModule: string,
  manifestDir: string = contextDir
): Promise<CardCapture> {
  const executedVia: CardCaptureSource =
    platformArch(targetPlatform) === hostDockerArch() ? "image" : "host";

  let stdout: string;
  try {
    stdout =
      executedVia === "image"
        ? await runCaptureContainer(localImageRef, agentModule)
        : await runCapturingStdout("python3", ["-m", "novaos_client_sdk.agent_card", agentModule], {
            cwd: manifestDir,
            env: hostCaptureEnv(contextDir, manifestDir),
          });
  } catch (err) {
    throw translateSdkImportFailure(err as Error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (err) {
    throw new Error(
      `Agent Card emitter (${executedVia}) did not print valid JSON: ${(err as Error).message}`
    );
  }

  const result = RuntimeCardSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Agent Card emitter (${executedVia}) returned an invalid runtime card: ${result.error.message}`
    );
  }
  return { ...result.data, executedVia };
}

export async function agentPublish(client: GalaxyHttpClient, opts: PublishOptions): Promise<void> {
  const {
    manifestPath,
    dockerfile: dockerfileOverride,
    context: contextOverride,
    dryRun,
    json,
    platform: platformOverride,
    envName,
  } = opts;

  const targetPlatform = resolveTargetPlatform(platformOverride, envName);

  // Step 1: Docker pre-flight
  if (!json) stderr("Checking Docker... ");
  ensureDocker();
  if (!json) stderr("ok\n");

  // Step 2: Read and validate manifest
  if (!json) stderr("Validating manifest... ");
  const rawContent = readFileSync(path.resolve(manifestPath), "utf-8");
  const rawManifest = JSON.parse(rawContent);
  const validationResult = validateManifest(rawManifest);

  if (!validationResult.valid) {
    const errors =
      validationResult.errors?.map((e) => `  ${e.path}: ${e.message}`).join("\n") ?? "";
    throw new Error(`Manifest validation failed:\n${errors}`);
  }

  const manifest = validationResult.manifest!;
  const agentModule = manifest.agent_module ?? DEFAULT_AGENT_MODULE;
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$/.test(
      agentModule
    )
  ) {
    throw new Error(
      "Invalid agent_module: expected MODULE:ATTR referencing an AgentBuilder (for example agent:agent)."
    );
  }
  // V2 names are runtime IDs, not display labels: preserve underscores/case.
  // The shared legacy helper only reads metadata.capabilities and slugifies it.
  const isV2Skills = Boolean(manifest.skills?.length);
  const declaredSkillIds = (
    isV2Skills ? manifest.skills!.map((skill) => skill.name) : deriveDeclaredSkillIds(rawManifest)
  ).sort();
  const pythonAgent = manifest.language === undefined || manifest.language === "python";
  const captureRequired =
    manifest.agent_module !== undefined || (pythonAgent && declaredSkillIds.length > 0);

  if (!manifest.version) {
    throw new Error(
      "Manifest must include a 'version' field for publishing. Use SemVer format (e.g., 1.0.0)."
    );
  }

  if (!semver.valid(manifest.version)) {
    throw new Error(`Invalid version "${manifest.version}". Must be valid SemVer (e.g., 1.0.0).`);
  }

  if (!json)
    stderr(`ok (${manifest.name} v${manifest.version}, publisher: ${manifest.publisher})\n`);

  if (!json && validationResult.warnings?.length) {
    for (const w of validationResult.warnings) {
      stderr(`  Warning: ${w}\n`);
    }
  }

  // TestPyPI → production PyPI cutover gate: a Python agent depends on
  // novaos-agent-sdk, which currently has no production PyPI release.
  // Written to stderr unconditionally (even with --json, which only
  // suppresses human progress narration on stdout) since this is a
  // production-deployability warning, not progress.
  if (manifest.language === "python" && isPreCutoverIndex()) {
    stderr(PYTHON_SDK_PRE_CUTOVER_WARNING);
  }

  // Step 3: Resolve Dockerfile and build context
  const dockerfile = resolveDockerfile(manifestPath, dockerfileOverride);
  const contextDir = contextOverride
    ? path.resolve(contextOverride)
    : path.dirname(path.resolve(manifestPath));

  // Step 4: Request publish authorization
  if (!json) stderr("Requesting publish authorization... ");

  const authResponse = await client.request<PublishAuthResponse>("/api/v1/agent-ops/publish/auth", {
    method: "POST",
    body: { manifest },
  });

  if (!authResponse.ok) {
    throw new Error(
      withRequestId(
        `Publish authorization failed (HTTP ${authResponse.status}): ${extractErrorDetail(authResponse.data)}`,
        authResponse
      )
    );
  }

  const authData = authResponse.data.data;
  if (!authData) {
    throw new Error("Publish auth: received empty response from server");
  }
  const latestInfo = authData.latest_version
    ? `, latest: ${authData.latest_version}`
    : ", first version";
  if (!json) stderr(`ok (new version${latestInfo})\n`);

  if (dryRun) {
    if (!json) {
      stderr("\n--dry-run: Skipping build, push, and finalize.\n");
      stderr(`  Would build: ${dockerfile}\n`);
      stderr(`  Would push to: ${authData.image_ref}\n`);
      stderr(`  Platform: ${targetPlatform}\n`);
      stderr(`  Agent UUID: ${authData.agent_uuid}\n`);
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            dry_run: true,
            image_ref: authData.image_ref,
            agent_uuid: authData.agent_uuid,
            latest_version: authData.latest_version,
          },
          null,
          2
        ) + "\n"
      );
    }
    return;
  }

  const localImageRef = rewriteImageRef(authData.image_ref);
  if (localImageRef !== authData.image_ref && !json) {
    stderr(`Registry rewrite: ${authData.image_ref} → ${localImageRef}\n`);
  }

  // Step 5: Docker build
  if (!json) stderr(`Building image (platform: ${targetPlatform})...\n`);
  await dockerBuild(localImageRef, dockerfile, contextDir, targetPlatform);
  if (!json) stderr("Image built.\n");

  // Capture before push: Python skill declarations and explicit targets require validation.
  // Other languages and legacy manifests without declarations retain best-effort discovery.
  let agentCardSource: CardCaptureSource | "unavailable" = "unavailable";

  if (!json) stderr("Capturing Agent Card from runtime... ");
  let runtimeSkills: AgentSkill[] | undefined;
  let runtimeStreaming: boolean | undefined;
  try {
    const capture = await captureRuntimeCard(
      localImageRef,
      contextDir,
      targetPlatform,
      agentModule,
      path.dirname(path.resolve(manifestPath))
    );
    agentCardSource = capture.executedVia;
    runtimeSkills = capture.skills;
    runtimeStreaming = capture.capabilities.streaming;
    if (!json) stderr(`ok (via ${capture.executedVia})\n`);
  } catch (err) {
    if (err instanceof SdkNotImportableError && manifest.language === "python") {
      if (!json) stderr("failed\n");
      throw err;
    }
    if (captureRequired) {
      throw new Error(
        `Runtime Agent Card capture required for ${agentModule}, but failed: ${(err as Error).message}. ` +
          "Set agent_module to the module:attribute of your AgentBuilder (not the FastAPI app). " +
          "For cross-architecture builds, activate a Python environment with the agent's dependencies installed."
      );
    }
    if (!json) stderr(`unavailable (${(err as Error).message})\n`);
  }

  if (runtimeSkills) {
    const runtimeSkillIds = [...runtimeSkills.map((s) => s.id)].sort();
    // Legacy declared ids are always slugified (agent-card.ts's buildSkills); a
    // runtime SKILL_ID is registered verbatim by AgentBuilder.skill() and never
    // is, so slugify the runtime side too before comparing against them, so a
    // manifest capability name and a SKILL_ID that are the same string but
    // differ only in case or underscore-vs-hyphen don't read as drift. V2
    // `skills[]` names are runtime IDs themselves (preserved verbatim above),
    // so they compare against the raw runtime ids instead — slugifying would
    // turn a byte-exact match into a false positive.
    const comparisonRuntimeIds = isV2Skills
      ? runtimeSkillIds
      : [...runtimeSkillIds.map(slugify)].sort();
    const disagrees =
      declaredSkillIds.length > 0 &&
      (declaredSkillIds.length !== comparisonRuntimeIds.length ||
        declaredSkillIds.some((id, i) => id !== comparisonRuntimeIds[i]));
    if (disagrees) {
      throw new Error(
        "Agent Card drift: the manifest declares skill ids " +
          `[${declaredSkillIds.join(", ")}] but the running agent registers ` +
          `[${runtimeSkillIds.join(", ")}]. Update the manifest's capabilities or the ` +
          "agent's @agent.skill() ids so they match exactly."
      );
    }
  }

  let agentCardAttached = false;
  try {
    // rawManifest, not the Zod-parsed `manifest`: AgentManifestV2Schema's
    // V1MetadataSchema only declares metadata.capabilities/domains/tags/
    // author.{name,email} and silently strips everything else on parse, so
    // buildAgentCard reading the parsed object would lose author.url
    // (provider), default_input_modes/output_modes, documentation_url and
    // icon_url — every manifest-owned field that is meant to
    // survive publish. rawManifest is the untouched JSON the author wrote.
    const card = buildAgentCard(
      rawManifest,
      undefined,
      runtimeSkills
        ? { skills: runtimeSkills, capabilities: { streaming: runtimeStreaming } }
        : undefined
    );
    (rawManifest as Record<string, unknown>)[AGENT_CARD_MANIFEST_KEY] = card;
    agentCardAttached = true;
  } catch (err) {
    if (!json) stderr(`Agent Card not attached (${(err as Error).message})\n`);
  }

  // Step 6: Docker push
  // When the server vends a registry token, use an isolated DOCKER_CONFIG so the
  // token is used directly without interference from any system credential helper
  // (e.g. gcloud auth docker-helper) that may be configured in ~/.docker/config.json.
  // credHelpers take priority over stored auths entries even after docker login, so
  // we skip docker login entirely and supply a fresh config via DOCKER_CONFIG.
  if (!json) stderr(`Pushing image to ${localImageRef}...\n`);
  if (authData.registry_auth_required && authData.registry_token) {
    const registryHost = localImageRef.split("/")[0];
    await dockerPushWithToken(localImageRef, registryHost, authData.registry_token);
  } else {
    await dockerPush(localImageRef);
  }
  if (!json) stderr("Image pushed.\n");

  // Step 7: Finalize publish
  if (!json) stderr("Registering with review pipeline... ");

  const idempotencyKey = `${manifest.publisher}:${manifest.name}:${manifest.version}`;

  const publishResponse = await client.request<PublishFinalizeResponse>(
    "/api/v1/agent-ops/publish/finalize",
    {
      method: "POST",
      body: {
        manifest: rawManifest,
        image_ref: authData.image_ref,
      },
      headers: {
        "X-Idempotency-Key": idempotencyKey,
      },
    }
  );

  if (!publishResponse.ok) {
    throw new Error(
      withRequestId(
        `Publish finalization failed (HTTP ${publishResponse.status}): ${extractErrorDetail(publishResponse.data)}`,
        publishResponse
      )
    );
  }

  const result = publishResponse.data.data;
  if (!result) {
    throw new Error("Publish finalize: received empty response from server");
  }
  if (!json) stderr("ok\n");

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ...result, agent_card_source: agentCardSource, agent_card_attached: agentCardAttached },
        null,
        2
      ) + "\n"
    );
  } else {
    stderr(`\nPublished! Review ID: ${result.review_id}\n`);
    stderr(`  Status: ${result.status}\n`);
    stderr(`  Image:  ${result.image_ref}\n`);
  }
}
