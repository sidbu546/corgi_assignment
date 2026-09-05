/**
 * inbox.ts — one idempotent pipeline that every inbound event flows through.
 *
 * "We will replay events, twice is one." So dedupe here is not a check-then-act
 * — it is a UNIQUE constraint on (provider, provider_event_id) claimed by an
 * INSERT ... ON CONFLICT DO NOTHING. Two simultaneous deliveries of the same
 * event race for one row; exactly one wins and processes, the other is recorded
 * as a duplicate. A `SELECT` followed by an `INSERT` would leave a window where
 * both see nothing and both process, which is precisely the bug a replay test
 * is designed to find.
 *
 * OUT-OF-ORDER DELIVERY is tolerated by construction rather than by sequence
 * numbers: handlers are written to be commutative. A fill that arrives before
 * its `accepted` event still books, because status is derived from whatever
 * events exist rather than advanced through a state machine that expects them
 * in order.
 *
 * A FAILED SIGNATURE RETURNS 200, and is recorded. A 4xx makes the provider
 * retry forever against an endpoint that will never accept the message; what we
 * actually want is the bad delivery captured, visible on a screen, and not
 * processed.
 *
 * POLLING IS A FALLBACK, NOT THE DESIGN. Where a provider offers no webhook
 * (Alpaca Broker sandbox has no webhook registration — every endpoint 404s),
 * a bridge consumes its event stream and posts into this same pipeline, so
 * there is one consumer and one idempotency story regardless of transport.
 */

import { transaction } from '../db';
import type { PoolClient } from 'pg';
import type { VerificationResult } from './signatures';

export type DeliveryOutcome =
  | 'processed'
  | 'duplicate'
  | 'rejected_signature'
  | 'unverifiable'
  | 'ignored'
  | 'failed';

export interface ReceiveResult {
  outcome: DeliveryOutcome;
  detail: string;
  deliveryId?: string;
  /** How many times this event id has now been delivered, including this one. */
  deliveryCount?: number;
}

export interface ReceiveInput {
  provider: string;
  /** The provider's own event id. The idempotency key. */
  providerEventId: string;
  eventType: string;
  rawBody: string;
  headers: Record<string, string>;
  verification: VerificationResult;
  /**
   * Does the actual work. Runs inside the same transaction that claimed the
   * dedupe row, so "recorded as processed" and "the money moved" commit or roll
   * back together. There is no window where we think we handled an event that
   * we did not.
   */
  handle: (client: PoolClient, payload: unknown) => Promise<string>;
}

export async function receiveWebhook(input: ReceiveInput): Promise<ReceiveResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    payload = { unparseable: input.rawBody.slice(0, 2000) };
  }

  // --- signature FIRST, before the dedupe key is claimed --------------------
  //
  // Ordering matters, and getting it wrong is a real vulnerability rather than
  // a style question. An idempotency key is a form of authority: if an
  // unauthenticated caller can claim it, they can post a garbage body under a
  // guessed event id and every genuine delivery of that event afterwards is
  // recorded as a "duplicate" and never processed. A forged request would
  // silently suppress a real fill, and every screen would show it as handled.
  //
  // So: verify, then claim. Unverified deliveries are still recorded — we want
  // attacks visible — but they are excluded from the unique index that drives
  // deduplication (see migration 0005), so they cannot shadow a real event.
  if (!input.verification.valid) {
    const outcome: DeliveryOutcome = input.verification.unverifiable
      ? 'unverifiable'
      : 'rejected_signature';

    const recorded = await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO webhook_deliveries
           (provider, provider_event_id, event_type, signature_valid,
            signature_detail, payload, headers, outcome, outcome_detail,
            processed_at)
         VALUES ($1, $2, $3, false, $4, $5::jsonb, $6::jsonb, $7, $4, now())
         RETURNING id`,
        [
          input.provider,
          input.providerEventId,
          input.eventType,
          input.verification.detail,
          JSON.stringify(payload),
          JSON.stringify(input.headers),
          outcome,
        ],
      );
      return rows[0].id;
    });

    return { outcome, deliveryId: recorded, detail: input.verification.detail };
  }

  // --- claim the dedupe key -------------------------------------------------
  // Its own transaction: the claim must survive even if handling later fails,
  // otherwise a permanently-failing event would be retried forever.
  //
  // The ON CONFLICT target names the partial index's predicate, so the conflict
  // is evaluated only against other VERIFIED deliveries.
  const claim = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO webhook_deliveries
         (provider, provider_event_id, event_type, signature_valid,
          signature_detail, payload, headers, outcome)
       VALUES ($1, $2, $3, true, $4, $5::jsonb, $6::jsonb, 'received')
       ON CONFLICT (provider, provider_event_id) WHERE signature_valid
       DO NOTHING
       RETURNING id`,
      [
        input.provider,
        input.providerEventId,
        input.eventType,
        input.verification.detail,
        JSON.stringify(payload),
        JSON.stringify(input.headers),
      ],
    );
    return rows[0]?.id ?? null;
  });

  // --- already seen: record the repeat and do nothing else ------------------
  if (!claim) {
    const repeat = await transaction(async (client) => {
      // `AND signature_valid` mirrors the partial unique index: the row we
      // conflicted with is by definition a verified one, and without this
      // predicate a previously-rejected forgery could be returned instead.
      const { rows } = await client.query<{ id: string; outcome: string }>(
        `SELECT id, outcome FROM webhook_deliveries
          WHERE provider = $1 AND provider_event_id = $2 AND signature_valid`,
        [input.provider, input.providerEventId],
      );
      const existing = rows[0];
      await client.query(
        `INSERT INTO webhook_duplicate_deliveries (delivery_id, headers)
         VALUES ($1, $2::jsonb)`,
        [existing.id, JSON.stringify(input.headers)],
      );
      const { rows: counted } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM webhook_duplicate_deliveries WHERE delivery_id = $1`,
        [existing.id],
      );
      return { id: existing.id, first: existing.outcome, repeats: Number(counted[0].n) };
    });

    return {
      outcome: 'duplicate',
      deliveryId: repeat.id,
      deliveryCount: repeat.repeats + 1,
      detail:
        `already handled (first outcome: ${repeat.first}). ` +
        `Delivered ${repeat.repeats + 1} times, acted on once.`,
    };
  }

  // --- handle ---------------------------------------------------------------
  // The signature was verified above, before the key was claimed, so anything
  // reaching this point is authentic.
  try {
    const detail = await transaction(async (client) => {
      const result = await input.handle(client, payload);
      await client.query(
        `UPDATE webhook_deliveries
            SET outcome = 'processed', outcome_detail = $2, processed_at = now()
          WHERE id = $1`,
        [claim, result],
      );
      return result;
    });
    return { outcome: 'processed', deliveryId: claim, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transaction(async (client) => {
      await client.query(
        `UPDATE webhook_deliveries
            SET outcome = 'failed', outcome_detail = $2, processed_at = now()
          WHERE id = $1`,
        [claim, message.slice(0, 1000)],
      );
    });
    // Still a 200 to the provider: the delivery is safely recorded and visible
    // on the inbox screen. Retries would not help and would only obscure it.
    return { outcome: 'failed', deliveryId: claim, detail: message };
  }
}

/** Headers worth keeping, without hoovering up anything sensitive. */
export function captureHeaders(headers: Headers): Record<string, string> {
  const keep = [
    'content-type',
    'user-agent',
    'x-forwarded-for',
    'persona-signature',
    'plaid-verification',
    'x-ledgerly-signature',
    'x-ledgerly-timestamp',
    'x-request-id',
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = headers.get(key);
    // Signature headers are kept because they are evidence of what was sent,
    // and they are useless without the secret. Secrets themselves never appear.
    if (value) out[key] = value.slice(0, 500);
  }
  return out;
}
