/**
 * POST /api/kyc — start identity verification, and (in sandbox) decide it.
 *
 *   { action: 'start' }              open a real Persona inquiry
 *   { action: 'approve' | 'decline'} drive it to a decision
 *
 * WHY THE DECISION CONTROLS EXIST AND ARE SAFE.
 *
 * `approve` and `decline` call PERSONA'S OWN sandbox endpoints. They do not set
 * our KYC status directly — nothing here writes to `kyc_events`. Persona makes
 * the decision, Persona emits the webhook, and our status changes only when
 * that signed webhook arrives and verifies. The route returns before any of
 * that has happened.
 *
 * That distinction is the whole point. If these buttons wrote our status
 * directly they would be a bypass of the identity gate wearing a UI. Instead
 * they are a way to make Persona produce an outcome on demand, which is what
 * lets the *declined* path be demonstrated at all — and "show pending and
 * rejected, not just approved" is the requirement.
 *
 * They are labelled as sandbox controls in the UI and would not exist in
 * production, where the customer completes the hosted flow themselves.
 */

import { NextResponse } from 'next/server';
import { transaction } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import {
  createInquiry,
  getInquiry,
  hostedFlowUrl,
  sandboxTransition,
} from '@/lib/providers/persona';
import { kycStatus, loadCustomer } from '@/lib/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireCustomer();
  const body = (await request.json().catch(() => ({}))) as {
    action?: 'start' | 'approve' | 'decline';
  };

  try {
    return await transaction(async (client) => {
      const customer = await loadCustomer(client, session.customerId);

      if (body.action === 'start') {
        const inquiry = await createInquiry({ customerId: customer.id });
        await client.query(
          `UPDATE customers SET persona_inquiry_id = $2 WHERE id = $1::uuid`,
          [customer.id, inquiry.id],
        );

        return NextResponse.json({
          ok: true,
          inquiryId: inquiry.id,
          status: inquiry.status,
          referenceId: inquiry.referenceId,
          hostedFlowUrl: hostedFlowUrl(inquiry.id),
          note:
            'A real Persona inquiry is open. Our KYC status will change only when ' +
            'Persona sends the signed webhook — nothing here writes it directly.',
        });
      }

      if (body.action === 'approve' || body.action === 'decline') {
        if (!customer.persona_inquiry_id) {
          return NextResponse.json(
            { error: 'Start verification first.' },
            { status: 400 },
          );
        }

        const result = await sandboxTransition(
          customer.persona_inquiry_id,
          body.action,
        );

        // Deliberately reporting OUR status as it stands right now, which is
        // almost certainly still the old one: the webhook has not arrived yet.
        // Showing the lag is more honest than pretending the click changed it.
        const ours = await kycStatus(client, customer.id);

        return NextResponse.json({
          ok: true,
          personaStatus: result.status,
          ourStatusRightNow: ours.status,
          note:
            `Persona now says "${result.status}". Our status is still ` +
            `"${ours.status}" because it changes only when the signed webhook ` +
            `arrives — usually a second or two. Refresh to see it land.`,
        });
      }

      // Default: report where things stand.
      const ours = await kycStatus(client, customer.id);
      const remote = customer.persona_inquiry_id
        ? await getInquiry(customer.persona_inquiry_id).catch(() => null)
        : null;

      return NextResponse.json({
        ok: true,
        ourStatus: ours.status,
        reason: ours.reason,
        inquiryId: customer.persona_inquiry_id,
        personaStatus: remote?.status ?? null,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
