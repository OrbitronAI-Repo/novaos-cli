import { resolveUrls } from "../config.js";
import { getEnvironment, isValidEnvironment } from "../environments.js";

function environmentApiBase(env: string): string {
  return getEnvironment(env).apiBase;
}

/** Admin connection URL for the Apps Postgres instance (CREATEDB role). */
export function resolveAppsPostgresUrl(): string {
  const url = process.env.APPS_POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "APPS_POSTGRES_URL is required for provision_db (Apps Postgres admin connection)"
    );
  }
  return url;
}

/** Base URL for agent-ops org subscription bind API (APP-18). */
export function resolveAgentOpsUrl(env: string): string {
  const override = process.env.NOVAOS_AGENT_OPS_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }
  if (isValidEnvironment(env)) {
    return resolveUrls(env).agentOpsUrl;
  }
  throw new Error(
    `NOVAOS_AGENT_OPS_URL is required when env "${env}" is not a known NovaOS environment preset`
  );
}

/** Base URL for app-ops catalog API (APP-03). */
export function resolveAppOpsUrl(env: string): string {
  const override = process.env.APP_OPS_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }
  if (isValidEnvironment(env)) {
    return `${environmentApiBase(env)}/app-ops`;
  }
  throw new Error(
    `APP_OPS_URL is required when env "${env}" is not a known NovaOS environment preset`
  );
}

/** GCP project id for Secret Manager paths (stub/local fallback). */
export function resolveGcpProjectId(): string {
  return process.env.NOVAOS_GCP_PROJECT_ID?.trim() ?? "local-dev";
}

/**
 * Marketplace admin API base (SA create / agent install / rotate).
 * Not the shared `api.*` gateway — those return nginx 404 for `/api/admin/*`.
 * Sourced from the named environment's own "marketplaceUrl" config field —
 * not every environment exposes a marketplace admin host, so this fails
 * closed rather than falling back to api.*.
 */
export function resolveMarketplaceAdminUrl(env: string): string {
  const override = process.env.NOVAOS_MARKETPLACE_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }
  const preset = isValidEnvironment(env) ? getEnvironment(env) : undefined;
  if (preset?.marketplaceUrl) {
    return preset.marketplaceUrl.replace(/\/$/, "");
  }
  throw new Error(
    `NOVAOS_MARKETPLACE_URL is required for env "${env}" ` +
      `(no marketplace admin host configured; api.* gateway is not valid for SA admin APIs)`
  );
}

/** Checkout path for nova-os-deployment (writes GitOps files). */
export function resolveNovaosDeploymentRepo(): string | null {
  const repoPath = process.env.NOVAOS_DEPLOYMENT_REPO?.trim();
  return repoPath && repoPath.length > 0 ? repoPath : null;
}

/** Local output directory when deployment repo is not configured. */
export function resolveNovaosDeploymentOutputDir(onboardingDir: string): string {
  const override = process.env.NOVAOS_DEPLOYMENT_OUTPUT_DIR?.trim();
  if (override) {
    return override;
  }
  return `${onboardingDir}/.provision-output/deployment`;
}

/** GCS assets bucket stub path prefix for logo upload. */
export function resolveAssetsUploadPrefix(env: string, slug: string): string {
  const bucket = process.env.NOVAOS_APP_ASSETS_BUCKET?.trim() ?? `novaos-app-assets-${env}`;
  return `gs://${bucket}/apps/${slug}`;
}
