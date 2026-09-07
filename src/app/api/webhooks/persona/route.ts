/**
 * POST /api/webhooks/persona — inbound identity-verification events. LIVE.
 *
 * Persona posts here when an inquiry changes state. The event moves the
 * customer's KYC status, which is what gates their ability to transact: an
 * unverified customer can log in and look, but cannot deposit or trade.
 *
 * The gate is enforced where the money moves, not here — this route only
 * records what Persona told us. A permission check that lives in a webhook
 * handler is a permission check that is trivially bypassed.
 */

import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { verifyPersona } from '@/lib/webhooks/signatures';
import { captureHeaders, receiveWebhook } from '@/lib/webhooks/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Persona event name -> our KYC status. Anything else is recorded, not acted on. */
const STATUS_MAP: Record<string, 'pending' | 'approved' | 'rejected'> = {
  'inquiry.created': 'pending',
  'inquiry.started': 'pending',
  'inquiry.completed': 'pending', // completed != passed; a human or workflow decides
  'inquiry.marked-for-review': 'pending',
  'inquiry.approved': 'approved',
  'inquiry.declined': 'rejected',
  'inquiry.failed': 'rejected',
  // An expiry is ABANDONMENT, not a decision. Persona expires an inquiry nobody
  // finished; it does not mean the person failed a check, because no check was
  // ever completed. Mapping it to 'rejected' told the customer "identity
  // verification was not successful" about a verification that never ran, and
  // applied the hardest block we have on the strength of a timeout.
  //
  // 'pending' is the honest state: still unverified, still gated, and the way
  // out is to start the flow again rather than to appeal a decision.
  'inquiry.expired': 'pending',
};

/**
 * Events that owe the customer an explanation. A decline needs one, and so does
 * an expiry — "still in progress" with no reason, six hours after they walked
 * away, is a dead end with no visible way out.
 *
 * Keyed on the EVENT, not the status: 'inquiry.created' also lands on 'pending'
 * and needs no explanation at all.
 */
const EXPLAINED_EVENTS = new Set([
  'inquiry.declined',
  'inquiry.failed',
  'inquiry.expired',
]);

interface PersonaEvent {
  data?: {
    id?: string;
    attributes?: {
      name?: string;
      'created-at'?: string;
      payload?: {
        data?: {
          id?: string;
          attributes?: {
            'reference-id'?: string;
            status?: string;
            'updated-at'?: string;
          };
        };
      };
    };
  };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = captureHeaders(request.headers);

  const verification = verifyPersona(
    rawBody,
    request.headers.get('persona-signature'),
    process.env.PERSONA_WEBHOOK_SECRET,
  );

  // Persona's own event id is the dedupe key. Falling back to a hash of the
  // body would make a genuine re-send look like a new event, so if the id is
  // absent we would rather record that plainly.
  let parsed: PersonaEvent = {};
  try {
    parsed = JSON.parse(rawBody) as PersonaEvent;
  } catch {
    /* recorded below as unparseable */
  }

  const eventId = parsed.data?.id ?? `no-event-id-${Date.now()}`;
  const eventType = parsed.data?.attributes?.name ?? 'unknown';

  const result = await receiveWebhook({
    provider: 'persona',
    providerEventId: eventId,
    eventType,
    rawBody,
    headers,
    verification,
    handle: async (client: PoolClient) => handlePersonaEvent(client, parsed, eventType),
  });

  // Always 200. See inbox.ts for why a 4xx on a bad signature is the wrong
  // answer: it makes the provider retry against an endpoint that will never
  // accept it, and hides the delivery instead of surfacing it.
  return NextResponse.json(
    { received: true, outcome: result.outcome, detail: result.detail },
    { status: 200 },
  );
}

async function handlePersonaEvent(
  client: PoolClient,
  event: PersonaEvent,
  eventType: string,
): Promise<string> {
  const inquiry = event.data?.attributes?.payload?.data;
  const inquiryId = inquiry?.id ?? null;
  const referenceId = inquiry?.attributes?.['reference-id'] ?? null;

  const status = STATUS_MAP[eventType];
  if (!status) {
    return `recorded but not acted on: '${eventType}' does not map to a KYC status`;
  }
  if (!referenceId) {
    return `recorded but not acted on: no reference-id, cannot attribute to a customer`;
  }

  const { rows } = await client.query<{
    id: string;
    legal_name: string;
    persona_inquiry_id: string | null;
  }>(
    `SELECT id, legal_name, persona_inquiry_id FROM customers WHERE id = $1::uuid`,
    [referenceId],
  );
  const customer = rows[0];
  if (!customer) {
    return `recorded but not acted on: no customer matching reference-id ${referenceId}`;
  }

  // A SUPERSEDED inquiry must not decide the customer's status.
  //
  // Persona expires abandoned inquiries on its own clock, hours later. One such
  // expiry arrived for an inquiry that had already been replaced, and because
  // status was "the latest event by effective_at" regardless of which inquiry
  // produced it, a dead inquiry reached forward and overwrote the live one.
  //
  // The rule: an event for an inquiry that is not the customer's current one is
  // recorded but not acted on — PROVIDED we have seen that inquiry before.
  // That proviso closes a race: a brand-new inquiry's first webhook can arrive
  // before `customers.persona_inquiry_id` has been updated to point at it, and
  // an unknown inquiry is far more likely to be that than a stale one.
  if (
    inquiryId &&
    customer.persona_inquiry_id &&
    inquiryId !== customer.persona_inquiry_id
  ) {
    const { rows: seen } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM kyc_events
        WHERE customer_id = $1::uuid AND provider_ref = $2`,
      [customer.id, inquiryId],
    );
    if (Number(seen[0]?.n ?? 0) > 0) {
      return (
        `recorded but not acted on: '${eventType}' is for superseded inquiry ` +
        `${inquiryId}; the current inquiry is ${customer.persona_inquiry_id}`
      );
    }
  }

  // Append-only: a new event row, never an update. The history of states is the
  // artefact an auditor wants, and "pending then declined then approved on
  // appeal" is a real sequence that an overwritten column would erase.
  //
  // effective_at is PERSONA'S timestamp, not ours. This matters more than it
  // looks: Persona genuinely delivers out of order — a real run delivered
  // `inquiry.declined` before `inquiry.created`, and ordering the history by
  // when we happened to receive each event showed a declined customer as merely
  // pending. Ordering by the provider's own event time is what makes
  // out-of-order delivery tolerable rather than merely survivable.
  const eventAt =
    event.data?.attributes?.['created-at'] ??
    inquiry?.attributes?.['updated-at'] ??
    null;

  await client.query(
    `INSERT INTO kyc_events
       (customer_id, status, provider, provider_ref, reason, raw, effective_at)
     VALUES ($1::uuid, $2, 'persona', $3, $4, $5::jsonb,
             coalesce($6::timestamptz, now()))`,
    [
      customer.id,
      status,
      inquiryId,
      EXPLAINED_EVENTS.has(eventType)
        ? eventType === 'inquiry.expired'
          ? 'Persona reported inquiry.expired — the verification was never ' +
            'completed and has timed out. Start it again to continue.'
          : `Persona reported ${eventType}`
        : null,
      JSON.stringify(event),
      eventAt,
    ],
  );

  return `${customer.legal_name}: KYC -> ${status} (${eventType}, inquiry ${inquiryId})`;
}
