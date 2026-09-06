/**
 * Bank linking through open banking. Both halves of the Plaid flow.
 *
 *   POST /api/funding/link            -> a link_token for the browser
 *   POST /api/funding/link/complete   -> exchange, verify, mint, redeem
 *
 * The second half is where the interesting decisions live: the identity on the
 * bank account is compared to the identity on file BEFORE a processor token is
 * minted, so an account belonging to someone else never becomes a funding
 * source in the first place.
 */

import { NextResponse } from 'next/server';
import { transaction } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import {
  createLinkToken,
  createProcessorToken,
  exchangePublicToken,
  getAccountsWithIdentity,
  nameMatches,
  sandboxCreatePublicToken,
} from '@/lib/providers/plaid';
import { createAchRelationshipFromPlaid } from '@/lib/providers/alpaca';
import {
  assertMayTransact,
  ensureBrokerageAccount,
  isUsableAccountStatus,
  loadCustomer,
  OnboardingError,
  waitForUsableBrokerageAccount,
} from '@/lib/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireCustomer();
  const body = (await request.json().catch(() => ({}))) as {
    action?: 'token' | 'complete' | 'sandbox-link';
    publicToken?: string;
    /** Demo control: link an account owned by someone else, to show the block. */
    mismatch?: boolean;
  };

  try {
    return await transaction(async (client) => {
      const customer = await loadCustomer(client, session.customerId);
      await assertMayTransact(client, customer.id);

      // ---- 1. token for the browser ---------------------------------------
      if (body.action === 'token') {
        const link = await createLinkToken({
          customerId: customer.id,
          customerName: customer.legal_name,
          webhookUrl: `${process.env.APP_BASE_URL}/api/webhooks/plaid`,
        });
        return NextResponse.json({ linkToken: link.linkToken });
      }

      // ---- 2. finish the link ---------------------------------------------
      // `sandbox-link` produces a public token server-side using Plaid's own
      // sandbox endpoint. It is the SAME public token the browser flow yields
      // and goes through the identical path below — it exists so the loop can
      // be demonstrated without a human driving an iframe, and it is labelled
      // as a sandbox shortcut in the UI.
      const publicToken =
        body.action === 'sandbox-link'
          ? await sandboxCreatePublicToken(
              body.mismatch ? {} : { ownerName: customer.legal_name },
            )
          : body.publicToken;

      if (!publicToken) {
        return NextResponse.json(
          { error: 'publicToken is required' },
          { status: 400 },
        );
      }

      const { accessToken, itemId } = await exchangePublicToken(publicToken);
      const { institutionName, accounts } = await getAccountsWithIdentity(accessToken);

      if (accounts.length === 0) {
        return NextResponse.json(
          { error: 'That institution returned no checking or savings account.' },
          { status: 400 },
        );
      }
      const funding = accounts[0];
      const match = nameMatches(funding.ownerNames, customer.legal_name);

      // Record the link whatever the verdict — including a refused one. An
      // attempted link from someone else's account is exactly the thing an ops
      // team wants to be able to find later.
      const { rows: linkRows } = await client.query<{ id: string }>(
        `INSERT INTO bank_links
           (customer_id, provider, provider_ref, institution, account_mask,
            account_name, name_match, is_active)
         VALUES ($1::uuid, 'plaid', $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          customer.id,
          itemId,
          institutionName ?? 'Unknown institution',
          funding.mask ?? '????',
          funding.name,
          match,
          match === true,
        ],
      );

      if (match !== true) {
        return NextResponse.json(
          {
            linked: false,
            nameMatch: match,
            institution: institutionName,
            accountOwner: funding.ownerNames.join(', ') || null,
            onFile: customer.legal_name,
            error:
              match === false
                ? `That account belongs to ${funding.ownerNames.join(', ')}, not ${customer.legal_name}. ` +
                  `We can only fund from an account you own.`
                : `Your bank did not report an account owner, so we cannot confirm ` +
                  `this account belongs to you. Recorded for review.`,
          },
          { status: 422 },
        );
      }

      // ---- 3. mint a token scoped to Alpaca, and redeem it ----------------
      const alpacaAccountId = await ensureBrokerageAccount(client, customer);

      // A brand-new account is not immediately ACTIVE, and Alpaca refuses an
      // ACH relationship until it is. Say that clearly rather than surfacing a
      // provider error that reads like a bug in us.
      const accountStatus = await waitForUsableBrokerageAccount(alpacaAccountId);
      if (!isUsableAccountStatus(accountStatus)) {
        return NextResponse.json(
          {
            linked: false,
            alpacaAccountId,
            accountStatus,
            error:
              `Your brokerage account is still being opened at the broker ` +
              `(status ${accountStatus}). The bank link needs an open account. ` +
              `Wait a few seconds and press the button again — the account is ` +
              `already created, so this will not open a second one.`,
          },
          { status: 409 },
        );
      }

      const processorToken = await createProcessorToken({
        accessToken,
        accountId: funding.accountId,
      });

      const relationship = await createAchRelationshipFromPlaid({
        accountId: alpacaAccountId,
        processorToken,
      });

      await client.query(
        `UPDATE bank_links SET alpaca_relationship_id = $2 WHERE id = $1::uuid`,
        [linkRows[0].id, relationship.id],
      );
      await client.query(
        `UPDATE customers SET plaid_item_id = $2 WHERE id = $1::uuid`,
        [customer.id, itemId],
      );

      return NextResponse.json({
        linked: true,
        nameMatch: true,
        institution: institutionName,
        accountName: funding.name,
        mask: funding.mask,
        accountOwner: funding.ownerNames.join(', '),
        alpacaAccountId,
        relationshipId: relationship.id,
        relationshipStatus: relationship.status,
      });
    });
  } catch (error) {
    if (error instanceof OnboardingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
