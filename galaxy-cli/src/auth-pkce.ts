/**
 * novaos-cli OAuth2 PKCE Utilities
 *
 * Code verifier/challenge/state generation and authorization URL
 * construction for the Authorization Code Flow with PKCE.
 */

import { randomBytes, createHash } from "node:crypto";

import { PKCE_CODE_VERIFIER_LENGTH } from "./constants.js";

export function generateCodeVerifier(): string {
  return randomBytes(PKCE_CODE_VERIFIER_LENGTH)
    .toString("base64url")
    .slice(0, PKCE_CODE_VERIFIER_LENGTH);
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizationUrl(params: {
  iamUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string;
  resource: string;
}): string {
  const url = new URL(`${params.iamUrl}/oidc/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", params.scopes);
  url.searchParams.set("resource", params.resource);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}
