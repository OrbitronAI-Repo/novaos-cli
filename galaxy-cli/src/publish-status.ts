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

/** One plain sentence per review state, on stderr (human output only, never in --json). */
const STATUS_MEANING: Record<string, string> = {
  PENDING_SCAN: "Security scan running.",
  PENDING_REVIEW:
    "Waiting for a platform admin to approve it. A publisher who isn't a platform admin can't approve their own version.",
  APPROVED: "Approved; activating.",
  ACTIVE: "Live. Install it to get an instance ID, then run it.",
  REJECTED: "Rejected. Read the review notes, fix, and publish again.",
  ROLLED_BACK: "Rolled back. Publish a new version to make it live again.",
};

/** States `--wait` stops at. */
const TERMINAL_STATES = new Set(["ACTIVE", "REJECTED", "ROLLED_BACK"]);
/** Terminal states that mean the version is not live: exit non-zero. */
const FAILED_STATES = new Set(["REJECTED", "ROLLED_BACK"]);

export const DEFAULT_WAIT_TIMEOUT_S = 900;
const POLL_START_MS = 2_000;
const POLL_MAX_MS = 15_000;

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
  opts: {
    json?: boolean;
    verify?: boolean;
    gatewayClient?: GalaxyHttpClient;
    /** Poll until ACTIVE, REJECTED or ROLLED_BACK (or the timeout). */
    wait?: boolean;
    /** `--wait` limit in seconds (default 900). */
    timeoutSeconds?: number;
    /** Injected for tests. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }
): Promise<{ cardVerified?: boolean; status: string; exitCode: number }> {
  const fetchReview = async (): Promise<ReviewStatus> => {
    const res = await client.request<{ data: ReviewStatus }>(
      `/api/v1/agent-ops/publish/status/${reviewId}`
    );
    if (!res.ok) {
      throw new Error(withRequestId(`Failed to fetch review status: HTTP ${res.status}`, res));
    }
    const r = res.data.data;
    if (!r) {
      throw new Error(`Review ${reviewId} not found`);
    }
    return r;
  };

  let review = await fetchReview();
  let timedOut = false;

  if (opts.wait) {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
    const deadline = now() + timeoutMs;
    let delay = POLL_START_MS;
    let lastShown = "";
    while (!TERMINAL_STATES.has(review.status)) {
      if (review.status !== lastShown) {
        lastShown = review.status;
        process.stderr.write(
          `Waiting... status: ${STATUS_DISPLAY[review.status] ?? review.status}\n`
        );
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      await sleep(Math.min(delay, remaining));
      delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
      try {
        review = await fetchReview();
      } catch (err) {
        // Keep waiting through a failed poll; the deadline still bounds the loop.
        process.stderr.write(
          `Status check failed, still waiting: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  const exitCodeFor = (cardVerified?: boolean): number =>
    timedOut || FAILED_STATES.has(review.status) || cardVerified === false ? 1 : 0;
  const finishTimeout = () => {
    if (timedOut) {
      process.stderr.write(
        `\nTimed out after ${opts.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_S}s waiting for review ${review.review_id}; last status: ${review.status}. Run publish-status again to keep waiting.\n`
      );
    }
  };

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
    finishTimeout();
    return { cardVerified, status: review.status, exitCode: exitCodeFor(cardVerified) };
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
  const meaning = STATUS_MEANING[review.status];
  if (meaning) {
    process.stderr.write(`\n${meaning}\n`);
  }
  finishTimeout();

  return { cardVerified, status: review.status, exitCode: exitCodeFor(cardVerified) };
}
