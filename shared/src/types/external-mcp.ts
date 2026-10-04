export const ExternalMcpErrorCategory = {
  CONNECTION_REFUSED: "CONNECTION_REFUSED",
  AUTH_FAILED: "AUTH_FAILED",
  INVALID_PROTOCOL: "INVALID_PROTOCOL",
  NO_TOOLS_DISCOVERED: "NO_TOOLS_DISCOVERED",
  TIMEOUT: "TIMEOUT",
  DUPLICATE: "DUPLICATE",
  /** The registered URL failed a per-call SSRF re-check (IP
   * literal, cloud metadata host, private IP, or non-HTTPS). Also used by the
   * DCR discovery guard for a *discovered* authorization-server
   * URL — registration_endpoint / authorization_endpoint / token_endpoint —
   * that resolves to a private/internal address, including at connect time
   * (DNS rebind). */
  SSRF_BLOCKED: "SSRF_BLOCKED",
  /** EXTERNAL_MCP_ENABLED is false on this deployment; the
   * platform-admin deployment gate, not a per-request validation failure. */
  EXTERNAL_MCP_DISABLED: "EXTERNAL_MCP_DISABLED",
  /** Connector is registered but has not yet been
   * approved by a platform admin. Tool invocation is refused and its tools
   * are excluded from GET /tools until the connector's status flips to
   * "active" via the admin approve action.
   *
   * SEAM: also covers a DCR (Dynamic Client Registration)
   * connector registration that is `pending_review` and has not yet been
   * approved by a platform admin. Token exchange and tool invocation are
   * refused until approval. Both flows share this single category rather
   * than each defining their own. */
  EXTERNAL_MCP_PENDING_APPROVAL: "EXTERNAL_MCP_PENDING_APPROVAL",
  /** A platform admin rejected this connector's
   * registration. Distinct from EXTERNAL_MCP_PENDING_APPROVAL so callers can
   * tell "not reviewed yet" from "reviewed and refused". */
  EXTERNAL_MCP_REJECTED: "EXTERNAL_MCP_REJECTED",
  /** A platform admin disabled a previously-approved
   * connector. Distinct from EXTERNAL_MCP_DISABLED (the deployment-wide
   * EXTERNAL_MCP_ENABLED gate) — this is a per-connector admin action. */
  EXTERNAL_MCP_CONNECTOR_DISABLED: "EXTERNAL_MCP_CONNECTOR_DISABLED",
  /**
   * The MCP server's authorization
   * server metadata does not support usable Dynamic Client Registration
   * (RFC 7591): no `registration_endpoint`, or it is missing
   * `authorization_endpoint`/`token_endpoint`, or it advertises PKCE methods
   * without S256. Distinct from AUTH_FAILED, which is a credential problem
   * with an otherwise-working DCR server.
   */
  DCR_NO_REGISTRATION_ENDPOINT: "DCR_NO_REGISTRATION_ENDPOINT",
  UNEXPECTED: "UNEXPECTED",
} as const;

export type ExternalMcpErrorCategory =
  (typeof ExternalMcpErrorCategory)[keyof typeof ExternalMcpErrorCategory];

export interface ExternalMcpErrorEnvelope {
  error_category: ExternalMcpErrorCategory;
  user_message: string;
  connector_id?: string;
}

export const EXTERNAL_MCP_ERROR_MESSAGES: Record<ExternalMcpErrorCategory, string> = {
  CONNECTION_REFUSED:
    "The external MCP server could not be reached. Check the server URL and try again.",
  AUTH_FAILED: "Authentication failed — verify the token or API key and try again.",
  INVALID_PROTOCOL:
    "The server did not return a valid MCP response. Contact the connector operator.",
  NO_TOOLS_DISCOVERED:
    "The connector is reachable but provides no usable tools. Contact the connector operator.",
  TIMEOUT: "The external MCP server did not respond in time. Try again or check the server status.",
  DUPLICATE: "This connector is already registered. Review the existing entry.",
  SSRF_BLOCKED:
    "This connector's server URL is not allowed (private, cloud-internal, or not HTTPS). Contact the connector operator.",
  EXTERNAL_MCP_DISABLED:
    "External MCP connectors are disabled on this deployment. Contact your platform administrator.",
  EXTERNAL_MCP_PENDING_APPROVAL:
    "This connector is awaiting platform admin approval and cannot be used yet.",
  EXTERNAL_MCP_REJECTED: "This connector's registration was rejected by a platform administrator.",
  EXTERNAL_MCP_CONNECTOR_DISABLED: "This connector has been disabled by a platform administrator.",
  DCR_NO_REGISTRATION_ENDPOINT:
    "This server does not support automatic OAuth client registration. Contact the connector operator or use a different auth type.",
  UNEXPECTED: "An unexpected error occurred. Check the server URL and credentials, then try again.",
};

export function buildExternalMcpErrorEnvelope(
  category: ExternalMcpErrorCategory,
  connectorId?: string
): ExternalMcpErrorEnvelope {
  return {
    error_category: category,
    user_message: EXTERNAL_MCP_ERROR_MESSAGES[category],
    ...(connectorId ? { connector_id: connectorId } : {}),
  };
}
