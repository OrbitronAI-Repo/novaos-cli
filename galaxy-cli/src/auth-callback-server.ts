/**
 * novaos-cli OAuth Localhost Callback Handling
 *
 * Processes the redirect NovaOS ID (Logto) sends back to the CLI's temporary
 * localhost HTTP server during the PKCE login flow.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { PKCE_CALLBACK_PATH } from "./constants.js";

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>novaos-cli</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#4ade80;margin-bottom:0.5rem}p{color:#999}</style></head>
<body><div class="card"><h1>Authenticated</h1><p>You can close this tab and return to the terminal.</p></div></body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>novaos-cli</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#f87171;margin-bottom:0.5rem}p{color:#999}</style></head>
<body><div class="card"><h1>Authentication Failed</h1><p>Check the terminal for details.</p></div></body></html>`;

/**
 * Process a single HTTP request on the OAuth callback server.
 * Returns { code, redirectUri } on success, { error } on failure,
 * or null when the request path does not match the callback route.
 */
export function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  port: number
): { code: string; redirectUri: string } | { error: string } | null {
  const requestUrl = new URL(req.url || "/", `http://localhost:${port}`);

  if (requestUrl.pathname !== PKCE_CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return null;
  }

  const error = requestUrl.searchParams.get("error");
  if (error) {
    const description = requestUrl.searchParams.get("error_description") || error;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(ERROR_HTML);
    return { error: `Authorization denied: ${description}` };
  }

  const code = requestUrl.searchParams.get("code");
  const callbackState = requestUrl.searchParams.get("state");

  if (!code || !callbackState) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(ERROR_HTML);
    return { error: "Invalid callback: missing code or state parameter." };
  }

  if (callbackState !== expectedState) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(ERROR_HTML);
    return { error: "State mismatch — possible CSRF attack. Authentication aborted." };
  }

  const redirectUri = `http://localhost:${port}${PKCE_CALLBACK_PATH}`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(SUCCESS_HTML);
  return { code, redirectUri };
}
