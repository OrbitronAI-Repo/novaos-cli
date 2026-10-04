/**
 * novaos-cli OIDC HTTP Client
 *
 * Token exchange, refresh, and userinfo requests against NovaOS ID (Logto).
 */

import { parseUpstreamJson } from "@novaos-cli/shared/safe-parse-response";

import { REQUEST_TIMEOUT_MS } from "./constants.js";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface UserInfoResponse {
  sub?: string;
  email?: string;
  name?: string;
}

export interface OidcTokenClient {
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    iamUrl: string;
    apiResource: string;
  }): Promise<TokenResponse>;
  refresh(params: {
    refreshToken: string;
    clientId: string;
    iamUrl: string;
    apiResource: string;
    /** When set, Logto returns an org-scoped access token with organization_id claim. */
    organizationId?: string;
  }): Promise<TokenResponse>;
  fetchUserInfo(params: { accessToken: string; iamUrl: string }): Promise<UserInfoResponse>;
}

export class FetchOidcTokenClient implements OidcTokenClient {
  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    iamUrl: string;
    apiResource: string;
  }): Promise<TokenResponse> {
    const response = await fetch(`${params.iamUrl}/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: params.clientId,
        code: params.code,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
        resource: params.apiResource,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token exchange failed: HTTP ${response.status} — ${body}`);
    }

    return parseUpstreamJson<TokenResponse & Record<string, unknown>>(
      response,
      ["access_token"],
      "OIDC token"
    );
  }

  async refresh(params: {
    refreshToken: string;
    clientId: string;
    iamUrl: string;
    apiResource: string;
    organizationId?: string;
  }): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: params.clientId,
      refresh_token: params.refreshToken,
      resource: params.apiResource,
    });
    if (params.organizationId) {
      body.set("organization_id", params.organizationId);
    }

    const response = await fetch(`${params.iamUrl}/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(
        `Token refresh failed: HTTP ${response.status} — ${errBody}. Run 'novaos-cli auth login' to re-authenticate.`
      );
    }

    return parseUpstreamJson<TokenResponse & Record<string, unknown>>(
      response,
      ["access_token"],
      "OIDC token"
    );
  }

  async fetchUserInfo(params: { accessToken: string; iamUrl: string }): Promise<UserInfoResponse> {
    const response = await fetch(`${params.iamUrl}/oidc/userinfo`, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`UserInfo request failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      sub: typeof data.sub === "string" ? data.sub : undefined,
      email: typeof data.email === "string" ? data.email : undefined,
      name: typeof data.name === "string" ? data.name : undefined,
    };
  }
}
