/**
 * Structured error categories for connector invocations.
 *
 * Agents branch on `error_category` in tool call results instead of parsing
 * error messages. Follows the same `as const` pattern as ExternalMcpErrorCategory.
 */

export const ConnectorErrorCategory = {
  CONNECTOR_AUTH_FAILED: "CONNECTOR_AUTH_FAILED",
  CONNECTOR_PERMISSION_DENIED: "CONNECTOR_PERMISSION_DENIED",
  /** DC-US-09 — no error class maps here yet; acceptable because DC-US-09 is in the same release train. */
  CONNECTOR_TOOL_DISABLED: "CONNECTOR_TOOL_DISABLED",
  CONNECTOR_RATE_LIMITED: "CONNECTOR_RATE_LIMITED",
  CONNECTOR_UNAVAILABLE: "CONNECTOR_UNAVAILABLE",
  CONNECTOR_TIMEOUT: "CONNECTOR_TIMEOUT",
  CONNECTOR_INVALID_INPUT: "CONNECTOR_INVALID_INPUT",
  /** DC-US-07 G3 will deliver OAuthRequiredError with this category. */
  CONNECTOR_OAUTH_REQUIRED: "CONNECTOR_OAUTH_REQUIRED",
  CONNECTOR_OPERATION_CANCELLED: "CONNECTOR_OPERATION_CANCELLED",
  CONNECTOR_UNEXPECTED: "CONNECTOR_UNEXPECTED",
} as const;

export type ConnectorErrorCategory =
  (typeof ConnectorErrorCategory)[keyof typeof ConnectorErrorCategory];

/**
 * Maps ExternalMcpErrorCategory string values to ConnectorErrorCategory.
 * Used when connector-host proxies to an external MCP server and needs to
 * translate the external error taxonomy into the connector category space.
 */
export function mapExternalMcpCategoryToConnector(
  externalCategory: string
): ConnectorErrorCategory {
  switch (externalCategory) {
    case "AUTH_FAILED":
      return ConnectorErrorCategory.CONNECTOR_AUTH_FAILED;
    case "CONNECTION_REFUSED":
    case "INVALID_PROTOCOL":
      return ConnectorErrorCategory.CONNECTOR_UNAVAILABLE;
    case "TIMEOUT":
      return ConnectorErrorCategory.CONNECTOR_TIMEOUT;
    case "NO_TOOLS_DISCOVERED":
      return ConnectorErrorCategory.CONNECTOR_UNAVAILABLE;
    case "SSRF_BLOCKED":
      return ConnectorErrorCategory.CONNECTOR_PERMISSION_DENIED;
    case "DCR_NO_REGISTRATION_ENDPOINT":
      return ConnectorErrorCategory.CONNECTOR_UNAVAILABLE;
    // Pending/rejected/admin-disabled connectors are all "not authorized to
    // use right now" from the caller's perspective.
    // EXTERNAL_MCP_PENDING_APPROVAL is shared with the DCR (Dynamic Client
    // Registration) flow, which reuses the same category for a pending DCR
    // registration.
    case "EXTERNAL_MCP_PENDING_APPROVAL":
    case "EXTERNAL_MCP_REJECTED":
    case "EXTERNAL_MCP_CONNECTOR_DISABLED":
      return ConnectorErrorCategory.CONNECTOR_PERMISSION_DENIED;
    default:
      return ConnectorErrorCategory.CONNECTOR_UNEXPECTED;
  }
}
