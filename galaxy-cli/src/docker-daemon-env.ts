import { execSync } from "node:child_process";

/**
 * Resolves how the Docker CLI should reach the daemon.
 *
 * When `DOCKER_CONFIG` points at a minimal temp dir (registry token push), Docker
 * ignores ~/.docker/config.json and defaults to unix:///var/run/docker.sock. Docker
 * Desktop on macOS/Windows uses a context-specific socket instead.
 */
export function resolveDockerDaemonHost(): string | undefined {
  if (process.env.DOCKER_HOST) {
    return process.env.DOCKER_HOST;
  }
  try {
    const host = execSync("docker context inspect -f '{{.Endpoints.docker.Host}}'", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Env for `docker push` with an isolated config.json (registry auth only). */
export function envForIsolatedDockerConfig(tmpConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: tmpConfigDir };
  const host = resolveDockerDaemonHost();
  if (host) {
    env.DOCKER_HOST = host;
  }
  return env;
}

/** Message for a missing `docker buildx`, naming it and how to get it. */
export const DOCKER_BUILDX_MISSING_MESSAGE =
  "`docker buildx` is required to build the image but was not found.\n" +
  "Install it: Docker Desktop (macOS, Windows) includes buildx; on Linux install the " +
  "docker-buildx plugin (for example the `docker-buildx-plugin` package from Docker's apt/yum repository), " +
  "then check that `docker buildx version` works.";

/**
 * Extra hint when `DOCKER_CONFIG` is set. Docker finds plugins through its
 * config folder (`<config>/cli-plugins`, and Docker Desktop's
 * `cliPluginsExtraDirs` in `<config>/config.json`), so pointing
 * `DOCKER_CONFIG` at another folder hides a buildx that is installed under
 * `~/.docker`. Installing Docker again would not help in that case.
 */
export function dockerConfigBuildxHint(dockerConfig: string): string {
  return (
    `DOCKER_CONFIG is set to ${dockerConfig}, so Docker looks for plugins there, not in ~/.docker. ` +
    "If buildx is already installed, unset DOCKER_CONFIG, or link the plugin into that folder: " +
    `mkdir -p "${dockerConfig}/cli-plugins" && ln -s ~/.docker/cli-plugins/docker-buildx "${dockerConfig}/cli-plugins/docker-buildx" ` +
    "(Docker Desktop for Mac also keeps it in /Applications/Docker.app/Contents/Resources/cli-plugins)."
  );
}

/**
 * Fail early, with the fix named, when the Docker CLI has no `buildx` plugin.
 * Any stderr from the probe is appended, so a buildx that is installed but
 * broken (bad builder config, permissions) shows its real cause.
 * `exec` and `env` are injectable so tests need no Docker.
 */
export function ensureDockerBuildx(
  exec: (command: string) => unknown = (command) =>
    execSync(command, { stdio: ["ignore", "ignore", "pipe"] }),
  env: NodeJS.ProcessEnv = process.env
): void {
  try {
    exec("docker buildx version");
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr?.toString().trim();
    const lines = [DOCKER_BUILDX_MISSING_MESSAGE];
    if (env.DOCKER_CONFIG) lines.push(dockerConfigBuildxHint(env.DOCKER_CONFIG));
    if (stderr) lines.push(`Docker said: ${stderr}`);
    throw new Error(lines.join("\n"), { cause: error });
  }
}
