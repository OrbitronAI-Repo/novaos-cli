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
