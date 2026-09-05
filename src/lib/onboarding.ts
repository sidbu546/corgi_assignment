/**
 * onboarding.ts — get a customer to the point where they can transact.
 *
 * Three gates, in order, and none of them is skippable:
 *
 *   1. KYC approved            Persona says who they are
 *   2. brokerage account open  Alpaca has an ACTIVE account for them
 *   3. bank linked             Plaid verified an account they actually own
 *
 * The KYC gate is enforced HERE, in the server-side path that moves money, not
 * in the UI. A disabled button is a courtesy to honest users; it is not a
 * control.
 */

import type { PoolClient } from 'pg';
import { createAccount, getAccount } from './providers/alpaca';

export class OnboardingError extends Error {
  constructor(
    readonly code:
      | 'kyc_not_approved'
      | 'no_brokerage_account'
      | 'no_bank_link'
      | 'name_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export interface CustomerRecord {
  id: string;
  legal_name: string;
  email: string;
  alpaca_account_id: string | null;
  plaid_item_id: string | null;
}

export async function loadCustomer(
  client: PoolClient,
  customerId: string,
): Promise<CustomerRecord> {
  const { rows } = await client.query<CustomerRecord>(
    `SELECT id, legal_name, email, alpaca_account_id, plaid_item_id
       FROM customers WHERE id = $1::uuid`,
    [customerId],
  );
  if (!rows[0]) throw new Error(`no customer ${customerId}`);
  return rows[0];
}

export async function kycStatus(
  client: PoolClient,
  customerId: string,
): Promise<{ status: string; reason: string | null }> {
  const { rows } = await client.query<{ status: string; reason: string | null }>(
    `SELECT status::text AS status, reason FROM kyc_events
      WHERE customer_id = $1::uuid
      ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [customerId],
  );
  return rows[0] ?? { status: 'not_started', reason: null };
}

/**
 * The gate. Called by every server route that moves money.
 *
 * Deliberately throws rather than returning a boolean: a caller that forgets to
 * check a boolean gets money movement; a caller that forgets to catch gets a
 * 500. Failing loudly is the safer default when the failure mode is
 * "unverified person moves money".
 */
export async function assertMayTransact(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  const kyc = await kycStatus(client, customerId);
  if (kyc.status !== 'approved') {
    throw new OnboardingError(
      'kyc_not_approved',
      `identity verification is ${kyc.status}; deposits and trading are disabled`,
    );
  }
}

/**
 * A brokerage account for this customer, creating one if needed.
 *
 * The identity submitted to Alpaca is a TEST identity derived from the demo
 * customer — never real personal data, which is both a rule of this trial and
 * simply the right thing to do. A real product collects this in onboarding and
 * passes it through; the shape of the call is identical.
 */
export async function ensureBrokerageAccount(
  client: PoolClient,
  customer: CustomerRecord,
): Promise<string> {
  if (customer.alpaca_account_id) {
    // Confirm it still exists and is usable rather than trusting our own column.
    try {
      const account = await getAccount(customer.alpaca_account_id);
      if (account.status === 'ACTIVE' || account.status === 'APPROVED') {
        return customer.alpaca_account_id;
      }
    } catch {
      // Fall through and open a new one; the stored id is stale.
    }
  }

  const [given, ...rest] = customer.legal_name.split(' ');
  const family = rest.join(' ') || 'Demo';
  const stamp = Date.now();

  const account = await createAccount({
    email: `alpaca+${customer.id.slice(0, 8)}.${stamp}@example.com`,
    givenName: given,
    familyName: family,
    dateOfBirth: '1990-01-01',
    // Syntactically valid, fictional. Alpaca rejects SSN areas 000, 666 and
    // 900-999, so the generated area is kept inside 100-599.
    taxId:
      `${100 + (stamp % 500)}-` +
      `${String(10 + (stamp % 89)).padStart(2, '0')}-` +
      `${String(1000 + (stamp % 8999)).padStart(4, '0')}`,
    phone: '+15551234567',
    street: ['20 N San Mateo Dr'],
    city: 'San Mateo',
    state: 'CA',
    postalCode: '94401',
  });

  await client.query(
    `UPDATE customers SET alpaca_account_id = $2 WHERE id = $1::uuid`,
    [customer.id, account.id],
  );

  return account.id;
}

export interface BankLinkRow {
  id: string;
  institution: string;
  account_mask: string;
  account_name: string;
  name_match: boolean | null;
  is_active: boolean;
  alpaca_relationship_id: string | null;
}

export async function activeBankLink(
  client: PoolClient,
  customerId: string,
): Promise<BankLinkRow | null> {
  const { rows } = await client.query<BankLinkRow>(
    `SELECT id, institution, account_mask, account_name, name_match, is_active,
            alpaca_relationship_id
       FROM bank_links
      WHERE customer_id = $1::uuid AND is_active
      ORDER BY recorded_at DESC LIMIT 1`,
    [customerId],
  );
  return rows[0] ?? null;
}
