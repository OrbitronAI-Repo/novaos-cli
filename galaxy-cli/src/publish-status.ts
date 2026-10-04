/**
 * Publish status — check the review pipeline status for a submitted agent.
 */

import { withRequestId, type GalaxyHttpClient } from "./http-client.js";

interface ReviewStatus {
  review_id: string;
  agent_id: string;
  version: string;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  reviewer_id: string | null;
  review_notes: string | null;
  scan_results: unknown;
}

const STATUS_DISPLAY: Record<string, string> = {
  PENDING_SCAN: "Pending scan",
  SCANNING: "Scanning",
  PENDING_REVIEW: "Awaiting admin review",
  APPROVED: "Approved (activating)",
  REJECTED: "Rejected",
  ACTIVE: "Active",
  ROLLED_BACK: "Rolled back",
};

/**
 * Mirrors AGENT_CARD_PATH in packages/gateway/src/routes/agent-card.ts —
 * duplicated rather than imported because the CLI does not depend on the
 * gateway package. Keep the two literally in sync if that route ever moves.
 */
function agentCardPath(agentId: string): string {
  return `/a2a/v1/agents/${encodeURIComponent(agentId)}/.well-known/agent-card.json`;
}

/**
 * Once activated, `review.agent_id` (this function's output) is also the
 * marketplace catalog's `agents.agent_id` and what the served Agent Card is
 * keyed by. `--verify` proves that rather than asserting
 * it: the printed id is the one this fetch actually resolved against the
 * live gateway, not just what the review row happens to say.
 */
export async function publishStatus(
  client: GalaxyHttpClient,
  reviewId: string,
  opts: { json?: boolean; verify?: boolean; gatewayClient?: GalaxyHttpClient }
): Promise<{ cardVerified?: boolean }> {
  const res = await client.request<{ data: ReviewStatus }>(
    `/api/v1/agent-ops/publish/status/${reviewId}`
  );

  if (!res.ok) {
    throw new Error(withRequestId(`Failed to fetch review status: HTTP ${res.status}`, res));
  }

  const review = res.data.data;

  if (!review) {
    throw new Error(`Review ${reviewId} not found`);
  }

  let cardUrl: string | undefined;
  let cardVerified: boolean | undefined;
  let cardVerifyError: string | undefined;
  if (opts.gatewayClient) {
    const path = agentCardPath(review.agent_id);
    cardUrl = `${opts.gatewayClient.getBaseUrl()}${path}`;
    if (opts.verify) {
      try {
        const cardRes = await opts.gatewayClient.request(path);
        cardVerified = cardRes.ok;
        if (!cardRes.ok) {
          cardVerifyError = withRequestId(
            `HTTP ${cardRes.status} — the served Agent Card does not resolve for agent_id "${review.agent_id}"`,
            cardRes
          );
        }
      } catch (err) {
        cardVerified = false;
        cardVerifyError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { ...review, agent_card_url: cardUrl, agent_card_verified: cardVerified },
        null,
        2
      ) + "\n"
    );
    return { cardVerified };
  }

  const statusLabel = STATUS_DISPLAY[review.status] ?? review.status;

  process.stdout.write(`Review:    ${review.review_id}\n`);
  process.stdout.write(`Agent:     ${review.agent_id}\n`);
  process.stdout.write(`Version:   ${review.version}\n`);
  process.stdout.write(`Status:    ${statusLabel}\n`);
  process.stdout.write(`Submitted: ${review.submitted_at}\n`);

  if (review.reviewed_at) {
    process.stdout.write(`Reviewed:  ${review.reviewed_at}\n`);
  }
  if (review.reviewer_id) {
    process.stdout.write(`Reviewer:  ${review.reviewer_id}\n`);
  }
  if (review.review_notes) {
    process.stdout.write(`Notes:     ${review.review_notes}\n`);
  }
  if (cardUrl) {
    process.stdout.write(`Card URL:  ${cardUrl}\n`);
  }
  if (cardVerified !== undefined) {
    process.stdout.write(`Verified:  ${cardVerified ? "yes — card resolves at that id" : "NO"}\n`);
    if (!cardVerified && cardVerifyError) {
      process.stderr.write(`\nCard verification failed: ${cardVerifyError}\n`);
    }
  }
  if (review.status === "REJECTED" && review.review_notes) {
    process.stderr.write(`\nRejection reason: ${review.review_notes}\n`);
  }

  return { cardVerified };
}
