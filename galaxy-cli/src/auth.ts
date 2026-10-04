/**
 * novaos-cli Authentication Module
 *
 * Handles OAuth2 Authorization Code Flow with PKCE against NovaOS ID (Logto),
 * secure credential storage, and transparent token refresh.
 *
 * All high-level auth functions (login, logout, getAccessToken, etc.) are
 * produced by createAuthModule(deps?) which accepts injectable dependencies
 * for testability. Default exports use production implementations.
 *
 * This module is the composition root: it wires together credential
 * persistence (./auth-credentials.js), OAuth2 PKCE (./auth-pkce.js), the OIDC
 * HTTP client (./auth-oidc-client.js), the localhost callback server
 * (./auth-callback-server.js), JWT claim decoding (./auth-jwt.js), local RBAC
 * checks (./auth-rbac.js), and org-selection policy (./auth-organization.js)
 * into the login/logout/getAccessToken/whoami/... flows below, and re-exports
 * each module's public surface so existing call sites are unaffected.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { handleOAuthCallback } from "./auth-callback-server.js";
import { CredentialStore, type StoredCredentials } from "./auth-credentials.js";
import {
  decodeIdentity,
  extractProfileFromIdToken,
  extractOrganizationIdFromClaims,
  membershipsFromCredentials,
  safeDecodeClaims,
  type AuthIdentity,
} from "./auth-jwt.js";
import {
  FetchOidcTokenClient,
  type OidcTokenClient,
  type TokenResponse,
} from "./auth-oidc-client.js";
import { resolveActiveOrganization, type OrganizationContextStore } from "./auth-organization.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthorizationUrl,
} from "./auth-pkce.js";
import { hasRole, assertDeveloperRole, assertPlatformAdmin } from "./auth-rbac.js";
import {
  getActiveOrganizationId as defaultGetActiveOrganizationId,
  getPersistedOrganizationId as defaultGetPersistedOrganizationId,
  setActiveOrganizationId as defaultSetActiveOrganizationId,
} from "./config.js";
import {
  TOKEN_REFRESH_BUFFER_SECONDS,
  PKCE_CALLBACK_PORTS,
  PKCE_CALLBACK_PATH,
  AUTH_TIMEOUT_MS,
  DEFAULT_IAM_URL,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPES,
  DEFAULT_API_RESOURCE,
  REQUIRED_CLI_ROLE,
} from "./constants.js";

// ---- Re-exports: each concern's public surface, unchanged for callers ----

export type { StoredCredentials } from "./auth-credentials.js";
export { CredentialStore } from "./auth-credentials.js";

export {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthorizationUrl,
} from "./auth-pkce.js";

export type { TokenResponse, UserInfoResponse, OidcTokenClient } from "./auth-oidc-client.js";
export { FetchOidcTokenClient } from "./auth-oidc-client.js";

export { handleOAuthCallback } from "./auth-callback-server.js";

export type { AuthIdentity } from "./auth-jwt.js";
export {
  extractRoles,
  extractProfileFromIdToken,
  extractOrganizationsFromClaims,
  extractOrganizationIdFromClaims,
  membershipsFromCredentials,
  decodeIdentity,
} from "./auth-jwt.js";

export { RBAC_LOCAL_CHECK_DISCLAIMER, hasRole } from "./auth-rbac.js";

export type { OrganizationContextStore } from "./auth-organization.js";
export { resolveActiveOrganization } from "./auth-organization.js";

// ---- Types owned by this module (orchestration/DI surface) ----

export interface GetAccessTokenOptions {
  /** Force refresh even when the cached token is unexpired. */
  forceRefresh?: boolean;
}

interface CallbackResult {
  code: string;
  redirectUri: string;
}

export interface AuthModuleDeps {
  store?: CredentialStore;
  tokenClient?: OidcTokenClient;
  organizationStore?: OrganizationContextStore;
  openBrowser?: (url: string) => Promise<void>;
  stderr?: { write: (s: string) => boolean };
  createHttpServer?: typeof createServer;
}

/**
 * Format the post-login success banner.
 * Missing claims render as "(none)" so the user can see what the session actually holds.
 */
export function formatLoginSuccessOutput(identity: AuthIdentity): string {
  const email = identity.email || identity.subject;
  const tenant = identity.organization_id || identity.tenant_id || identity.org_id || "(none)";
  const publisher = identity.publisher_name || identity.publisher_id || "(none)";
  const roles = identity.roles && identity.roles.length > 0 ? identity.roles.join(", ") : "(none)";

  return (
    `  Logged in as ${email}\n` +
    `  Tenant: ${tenant}\n` +
    `  Publisher: ${publisher}\n` +
    `  Roles: ${roles}\n\n`
  );
}

// ---- Auth Module Factory ----

export function createAuthModule(deps?: AuthModuleDeps) {
  const store = deps?.store ?? new CredentialStore();
  const tokenClient = deps?.tokenClient ?? new FetchOidcTokenClient();
  const organizationStore: OrganizationContextStore = deps?.organizationStore ?? {
    getActiveOrganizationId: defaultGetActiveOrganizationId,
    getPersistedOrganizationId: defaultGetPersistedOrganizationId,
    setActiveOrganizationId: defaultSetActiveOrganizationId,
  };
  const _openBrowser =
    deps?.openBrowser ??
    (async (url: string) => {
      const { default: open } = await import("open");
      await open(url);
    });
  const _stderr = deps?.stderr ?? process.stderr;
  const _createServer = deps?.createHttpServer ?? createServer;

  function tryListenOnPort(port: number): Promise<ReturnType<typeof createServer>> {
    return new Promise((resolve, reject) => {
      const server = _createServer();
      server.once("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        resolve(server);
      });
    });
  }

  function waitForCallback(
    server: ReturnType<typeof createServer>,
    port: number,
    expectedState: string
  ): Promise<CallbackResult> {
    return new Promise<CallbackResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Authentication timed out. No callback received within 2 minutes."));
      }, AUTH_TIMEOUT_MS);

      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        const result = handleOAuthCallback(req, res, expectedState, port);
        if (result === null) return;
        clearTimeout(timeout);
        if ("error" in result) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });
    });
  }

  async function resolveOrganizationForCredentials(
    credentials: StoredCredentials
  ): Promise<string | undefined> {
    const memberships = membershipsFromCredentials(credentials);
    const configured = await organizationStore.getActiveOrganizationId();
    const { organizationId, autoSelected } = resolveActiveOrganization({
      configuredOrganizationId: configured,
      memberships,
    });

    // Persist auto-selected org once (mirrors Marketplace cookie default).
    // Gate on the config-file value, not getActiveOrganizationId(): an invalid
    // NOVAOS_ORGANIZATION_ID keeps returning the env id forever, which would
    // rewrite config and print on every getAccessToken call.
    if (autoSelected && organizationId) {
      const persisted = organizationStore.getPersistedOrganizationId
        ? await organizationStore.getPersistedOrganizationId()
        : configured;
      if (persisted !== organizationId) {
        await organizationStore.setActiveOrganizationId(organizationId);
      }
      // Announce only when the effective active org actually became the selection
      // (skip when env still shadows an invalid override).
      const effective = await organizationStore.getActiveOrganizationId();
      if (effective === organizationId && configured !== organizationId) {
        _stderr.write(
          `  Active organization set to ${organizationId} (first membership; use 'novaos-cli auth org use <id>' to switch).\n\n`
        );
      }
    }

    return organizationId;
  }

  async function persistRefreshedCredentials(
    credentials: StoredCredentials,
    tokenResponse: TokenResponse
  ): Promise<StoredCredentials> {
    const updated: StoredCredentials = {
      ...credentials,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || credentials.refresh_token,
      id_token: tokenResponse.id_token || credentials.id_token,
      expires_at: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
    };
    await store.save(updated);
    return updated;
  }

  async function refreshCredentials(
    credentials: StoredCredentials,
    organizationId: string | undefined
  ): Promise<StoredCredentials> {
    if (!credentials.refresh_token) {
      throw new Error(
        "Token expired and no refresh token available. Run 'novaos-cli auth login' to re-authenticate."
      );
    }

    const tokenResponse = await tokenClient.refresh({
      refreshToken: credentials.refresh_token,
      clientId: credentials.client_id,
      iamUrl: credentials.iam_url,
      apiResource: DEFAULT_API_RESOURCE,
      organizationId,
    });

    return persistRefreshedCredentials(credentials, tokenResponse);
  }

  async function login(options?: { iamUrl?: string; clientId?: string }): Promise<AuthIdentity> {
    const iamUrl = options?.iamUrl || DEFAULT_IAM_URL;
    const clientId = options?.clientId || DEFAULT_CLIENT_ID;

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    _stderr.write("\n  Starting authentication...\n\n");

    let boundPort: number | null = null;
    let callbackServer: ReturnType<typeof createServer> | null = null;

    for (const port of PKCE_CALLBACK_PORTS) {
      try {
        callbackServer = await tryListenOnPort(port);
        boundPort = port;
        break;
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "EADDRINUSE") {
          continue;
        }
        throw err;
      }
    }

    if (!callbackServer || boundPort === null) {
      throw new Error(
        `Cannot start callback server. All ports are in use: ${PKCE_CALLBACK_PORTS.join(", ")}.\n` +
          `Free one of these ports and try again.`
      );
    }

    const redirectUri = `http://localhost:${boundPort}${PKCE_CALLBACK_PATH}`;

    const authUrl = buildAuthorizationUrl({
      iamUrl,
      clientId,
      redirectUri,
      codeChallenge,
      state,
      scopes: DEFAULT_SCOPES,
      resource: DEFAULT_API_RESOURCE,
    });

    _stderr.write("  Opening browser for authentication...\n\n");
    _stderr.write(`  If the browser doesn't open, visit:\n    ${authUrl}\n\n`);
    _stderr.write("  Waiting for authorization...\n\n");

    try {
      await _openBrowser(authUrl);
    } catch {
      // Browser open failed silently — user can open manually
    }

    const callbackResult = await waitForCallback(callbackServer, boundPort, state);

    callbackServer.close();

    const tokenResponse = await tokenClient.exchangeCode({
      code: callbackResult.code,
      redirectUri: callbackResult.redirectUri,
      codeVerifier,
      clientId,
      iamUrl,
      apiResource: DEFAULT_API_RESOURCE,
    });

    let profileEmail: string | undefined;
    let profileName: string | undefined;

    if (tokenResponse.id_token) {
      const profile = extractProfileFromIdToken(tokenResponse.id_token);
      profileEmail = profile.email;
      profileName = profile.name;
    }

    if (!profileEmail) {
      try {
        const userInfo = await tokenClient.fetchUserInfo({
          accessToken: tokenResponse.access_token,
          iamUrl,
        });
        profileEmail = profileEmail || userInfo.email;
        profileName = profileName || userInfo.name;
      } catch {
        // UserInfo fetch is best-effort during login
      }
    }

    let credentials: StoredCredentials = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || "",
      id_token: tokenResponse.id_token,
      email: profileEmail,
      name: profileName,
      expires_at: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
      iam_url: iamUrl,
      client_id: clientId,
    };

    await store.save(credentials);

    // Auth-code exchange is not org-scoped; refresh immediately when the user has orgs
    // so Gateway sees organization_id (same tenant as Marketplace).
    const organizationId = await resolveOrganizationForCredentials(credentials);
    if (organizationId && credentials.refresh_token) {
      try {
        credentials = await refreshCredentials(credentials, organizationId);
      } catch (err) {
        _stderr.write(
          `  Warning: Could not obtain org-scoped token for ${organizationId}: ${
            err instanceof Error ? err.message : String(err)
          }\n` +
            `  Agent runs, LLM and MCP calls will be rejected (ORG_CONTEXT_REQUIRED) until\n` +
            `  'novaos-cli auth org use ${organizationId}' succeeds.\n\n`
        );
      }
    }

    const identity = decodeIdentity(credentials);
    _stderr.write(formatLoginSuccessOutput(identity));

    if (!hasRole(identity.roles, REQUIRED_CLI_ROLE)) {
      _stderr.write(
        `  Warning: Your NovaOS ID account does not have the '${REQUIRED_CLI_ROLE}' role.\n` +
          `  Commands that require developer access will be rejected.\n` +
          `  Request the role from your workspace admin, or visit the Developer Portal.\n\n`
      );
    }

    return identity;
  }

  async function logout(): Promise<void> {
    await store.clear();
    _stderr.write("  Logged out. Credentials cleared.\n\n");
  }

  async function getAccessToken(options?: GetAccessTokenOptions): Promise<string> {
    let credentials = await store.load();

    if (!credentials) {
      throw new Error(
        "Not authenticated. Run 'novaos-cli auth login' to authenticate with NovaOS ID."
      );
    }

    const organizationId = await resolveOrganizationForCredentials(credentials);
    const tokenOrgId = extractOrganizationIdFromClaims(safeDecodeClaims(credentials.access_token));
    const now = Math.floor(Date.now() / 1000);
    const isExpired = credentials.expires_at - TOKEN_REFRESH_BUFFER_SECONDS <= now;
    // Refresh when the cached access token lacks the active org.
    const orgMismatch = organizationId !== undefined && tokenOrgId !== organizationId;

    if (!options?.forceRefresh && !isExpired && !orgMismatch) {
      return credentials.access_token;
    }

    credentials = await refreshCredentials(credentials, organizationId);
    return credentials.access_token;
  }

  async function getIdToken(): Promise<string | null> {
    const credentials = await store.load();
    return credentials?.id_token ?? null;
  }

  async function whoami(): Promise<AuthIdentity> {
    const credentialsBefore = await store.load();

    if (!credentialsBefore) {
      throw new Error(
        "Not authenticated. Run 'novaos-cli auth login' to authenticate with NovaOS ID."
      );
    }

    let tokenRefreshFailed = false;
    try {
      await getAccessToken();
    } catch {
      tokenRefreshFailed = true;
    }

    const credentials = (await store.load()) ?? credentialsBefore;
    const now = Math.floor(Date.now() / 1000);
    const isExpired = credentials.expires_at <= now;

    if (tokenRefreshFailed && isExpired) {
      const expiredIso = new Date(credentials.expires_at * 1000).toISOString();
      throw new Error(
        `Token expired at ${expiredIso}. Run \`novaos-cli auth login\` to re-authenticate.`
      );
    }

    const identity = decodeIdentity(credentials);

    if (!identity.email && !identity.name) {
      try {
        const userInfo = await tokenClient.fetchUserInfo({
          accessToken: credentials.access_token,
          iamUrl: credentials.iam_url,
        });
        if (userInfo.email || userInfo.name) {
          const updated: StoredCredentials = {
            ...credentials,
            email: userInfo.email,
            name: userInfo.name,
          };
          await store.save(updated);
          return decodeIdentity(updated);
        }
      } catch {
        // UserInfo fetch failed; return identity as-is
      }
    }

    return identity;
  }

  async function listOrganizations(): Promise<{
    organizations: string[];
    activeOrganizationId: string | undefined;
  }> {
    const credentials = await store.load();
    if (!credentials) {
      throw new Error(
        "Not authenticated. Run 'novaos-cli auth login' to authenticate with NovaOS ID."
      );
    }
    const memberships = membershipsFromCredentials(credentials);
    const configured = await organizationStore.getActiveOrganizationId();
    const { organizationId } = resolveActiveOrganization({
      configuredOrganizationId: configured,
      memberships,
    });
    return { organizations: memberships, activeOrganizationId: organizationId };
  }

  async function useOrganization(organizationId: string): Promise<AuthIdentity> {
    const trimmed = organizationId.trim();
    if (!trimmed) {
      throw new Error("Organization ID is required.");
    }

    const credentials = await store.load();
    if (!credentials) {
      throw new Error(
        "Not authenticated. Run 'novaos-cli auth login' to authenticate with NovaOS ID."
      );
    }

    const memberships = membershipsFromCredentials(credentials);
    if (memberships.length > 0 && !memberships.includes(trimmed)) {
      throw new Error(
        `Organization '${trimmed}' is not in your memberships: ${memberships.join(", ")}`
      );
    }

    // When the organizations claim is absent, JWT membership cannot be checked.
    // Persist only after a successful org-scoped refresh that returns the requested org.
    // Snapshot org + credentials so a failed switch cannot leave mismatched on-disk tokens.
    const previousPersisted = organizationStore.getPersistedOrganizationId
      ? await organizationStore.getPersistedOrganizationId()
      : await organizationStore.getActiveOrganizationId();
    const previousCredentials: StoredCredentials = { ...credentials };

    await organizationStore.setActiveOrganizationId(trimmed);
    try {
      await getAccessToken({ forceRefresh: true });
      const updated = await store.load();
      if (!updated) {
        throw new Error(
          "Not authenticated. Run 'novaos-cli auth login' to authenticate with NovaOS ID."
        );
      }
      const tokenOrgId = extractOrganizationIdFromClaims(safeDecodeClaims(updated.access_token));
      if (tokenOrgId !== trimmed) {
        throw new Error(
          `Identity provider did not issue an org-scoped token for '${trimmed}'. ` +
            `Confirm the organization ID is correct and that your account is a member.`
        );
      }
    } catch (err) {
      await organizationStore.setActiveOrganizationId(previousPersisted);
      await store.save(previousCredentials);
      throw err;
    }
    return whoami();
  }

  async function showOrganization(): Promise<{
    activeOrganizationId: string | undefined;
    tokenOrganizationId: string | undefined;
    tenant_id: string | undefined;
    organizations: string[];
  }> {
    await getAccessToken();
    const credentials = await store.load();
    if (!credentials) {
      throw new Error(
        "Not authenticated. Run 'novaos-cli auth login' to authenticate with NovaOS ID."
      );
    }
    const identity = decodeIdentity(credentials);
    // Report the membership-resolved org used for tokens (same as listOrganizations),
    // not the raw env/config value which may be invalid and unused for refresh.
    const memberships = membershipsFromCredentials(credentials);
    const configured = await organizationStore.getActiveOrganizationId();
    const { organizationId } = resolveActiveOrganization({
      configuredOrganizationId: configured,
      memberships,
    });
    return {
      activeOrganizationId: organizationId,
      tokenOrganizationId: identity.organization_id,
      tenant_id: identity.tenant_id,
      organizations: identity.organizations ?? memberships,
    };
  }

  /**
   * requireDeveloperRole/requirePlatformAdmin are local, non-authoritative UX
   * gates only — see the disclaimer comment in ./auth-rbac.js.
   */
  async function requireDeveloperRole(): Promise<AuthIdentity> {
    const identity = await whoami();
    assertDeveloperRole(identity);
    return identity;
  }

  async function requirePlatformAdmin(): Promise<AuthIdentity> {
    const identity = await whoami();
    assertPlatformAdmin(identity);
    return identity;
  }

  return {
    login,
    logout,
    getAccessToken,
    getIdToken,
    whoami,
    requireDeveloperRole,
    requirePlatformAdmin,
    listOrganizations,
    useOrganization,
    showOrganization,
  };
}

// ---- Backward-Compatible Exports ----

const defaultModule = createAuthModule();
export const {
  login,
  logout,
  getAccessToken,
  getIdToken,
  whoami,
  requireDeveloperRole,
  requirePlatformAdmin,
  listOrganizations,
  useOrganization,
  showOrganization,
} = defaultModule;
