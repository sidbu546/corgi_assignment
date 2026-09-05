/**
 * plaid.ts — bank linking and funding. LIVE against the Plaid sandbox.
 *
 * This is the seam where two live integrations meet, and it is the reason both
 * are here rather than one: Plaid proves the bank account belongs to the
 * customer and mints a PROCESSOR TOKEN, and Alpaca turns that token into an ACH
 * relationship. Neither we nor Alpaca ever handles a raw account number.
 *
 * The flow, in the order it actually happens:
 *
 *   1. link_token        we ask Plaid for a token that opens Link
 *   2. public_token      the customer completes Link in their browser
 *   3. access_token      we exchange the public token, server-side
 *   4. identity check    the name on the bank account vs the name on file
 *   5. processor_token   minted for Alpaca specifically
 *   6. ach_relationship  created at Alpaca from the processor token
 *
 * Step 4 is the one that is easy to skip and expensive to skip. The brief asks
 * that the account we pay into belongs to the claimant; funding an investment
 * account from someone else's bank is how money laundering works. The result is
 * recorded on the bank link and surfaced, not silently ignored.
 */

import { assertSlotAvailable, ProviderUnavailableError } from './registry';

const SLOT = 'funding';

function baseUrl(): string {
  return `https://${process.env.PLAID_ENV ?? 'sandbox'}.plaid.com`;
}

export class PlaidError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlaidError';
  }
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  assertSlotAvailable(SLOT);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        ...body,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    const json = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new PlaidError(
        response.status,
        json.error_code ?? 'UNKNOWN',
        `Plaid ${path}: ${json.error_code ?? response.status} — ${json.error_message ?? text.slice(0, 200)}`,
      );
    }
    return json as T;
  } catch (error) {
    if (error instanceof PlaidError) throw error;
    throw new ProviderUnavailableError(
      SLOT,
      'upstream',
      `Plaid ${path} failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// 1. link_token
// -----------------------------------------------------------------------------

export async function createLinkToken(input: {
  customerId: string;
  customerName: string;
  webhookUrl?: string;
}): Promise<{ linkToken: string; expiration: string }> {
  const result = await call<{ link_token: string; expiration: string }>(
    '/link/token/create',
    {
      user: { client_user_id: input.customerId },
      client_name: 'Ledgerly',
      products: ['auth'],
      // `identity` alongside `auth` so we can compare the account holder's name
      // to the name on file before we let money move.
      optional_products: ['identity'],
      country_codes: ['US'],
      language: 'en',
      ...(input.webhookUrl ? { webhook: input.webhookUrl } : {}),
    },
  );
  return { linkToken: result.link_token, expiration: result.expiration };
}

// -----------------------------------------------------------------------------
// 2-3. public_token -> access_token
// -----------------------------------------------------------------------------

export async function exchangePublicToken(
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const result = await call<{ access_token: string; item_id: string }>(
    '/item/public_token/exchange',
    { public_token: publicToken },
  );
  return { accessToken: result.access_token, itemId: result.item_id };
}

// -----------------------------------------------------------------------------
// 4. accounts and identity
// -----------------------------------------------------------------------------

export interface PlaidAccount {
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  subtype: string | null;
  /** Names Plaid reports as owners of this account. */
  ownerNames: string[];
}

export async function getAccountsWithIdentity(
  accessToken: string,
): Promise<{ institutionName: string | null; accounts: PlaidAccount[] }> {
  interface IdentityResponse {
    accounts: Array<{
      account_id: string;
      name: string;
      official_name: string | null;
      mask: string | null;
      subtype: string | null;
      owners?: Array<{ names?: string[] }>;
    }>;
    item: { institution_id?: string | null };
  }

  const result = await call<IdentityResponse>('/identity/get', {
    access_token: accessToken,
  });

  let institutionName: string | null = null;
  if (result.item.institution_id) {
    try {
      const inst = await call<{ institution: { name: string } }>(
        '/institutions/get_by_id',
        {
          institution_id: result.item.institution_id,
          country_codes: ['US'],
        },
      );
      institutionName = inst.institution.name;
    } catch {
      // A missing institution name is cosmetic; it must not block funding.
      institutionName = result.item.institution_id;
    }
  }

  return {
    institutionName,
    accounts: result.accounts
      // Only depository accounts can fund a brokerage account. Offering a
      // credit card here would fail later, confusingly.
      .filter((a) => a.subtype === 'checking' || a.subtype === 'savings')
      .map((a) => ({
        accountId: a.account_id,
        name: a.name,
        officialName: a.official_name,
        mask: a.mask,
        subtype: a.subtype,
        ownerNames: (a.owners ?? []).flatMap((o) => o.names ?? []),
      })),
  };
}

/**
 * Does the bank account belong to the person we think it does?
 *
 * Deliberately forgiving on FORM and strict on SUBSTANCE: case, punctuation,
 * middle names and name order are normalised away, because "Dana R. Whitfield"
 * and "WHITFIELD DANA" are the same person and rejecting them would just train
 * an ops team to override the check. A genuinely different surname is not.
 *
 * Returns null when Plaid gave us no owner names at all — unknown is not the
 * same as mismatched, and recording it as a pass would be a lie.
 */
export function nameMatches(
  ownerNames: readonly string[],
  legalName: string,
): boolean | null {
  if (ownerNames.length === 0) return null;

  const tokens = (name: string) =>
    new Set(
      name
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1),
    );

  const expected = tokens(legalName);
  if (expected.size === 0) return null;

  return ownerNames.some((owner) => {
    const actual = tokens(owner);
    let overlap = 0;
    for (const token of expected) if (actual.has(token)) overlap++;
    // Every token of the legal name must appear, ignoring extra middle names on
    // the bank's side.
    return overlap === expected.size;
  });
}

// -----------------------------------------------------------------------------
// 5. processor token for Alpaca
// -----------------------------------------------------------------------------

export async function createProcessorToken(input: {
  accessToken: string;
  accountId: string;
}): Promise<string> {
  const result = await call<{ processor_token: string }>(
    '/processor/token/create',
    {
      access_token: input.accessToken,
      account_id: input.accountId,
      processor: 'alpaca',
    },
  );
  return result.processor_token;
}

// -----------------------------------------------------------------------------
// Sandbox helpers — clearly labelled, used only to make the demo reproducible
// -----------------------------------------------------------------------------

/**
 * Create a linked item without opening Link in a browser.
 *
 * Plaid's own sandbox endpoint, not a simulator of ours: it returns a real
 * public token for a real sandbox institution, which then goes through exactly
 * the same exchange and processor-token path as a browser-driven link. It
 * exists so the seed and the smoke tests can run headless.
 */
export async function sandboxCreatePublicToken(
  opts: {
    institutionId?: string;
    /**
     * Force the identity Plaid reports as the account owner.
     *
     * Plaid's default sandbox user is always "Alberta Bobbeth Charleson", which
     * means the name-match check would fail for every demo customer and the
     * happy path would be unreachable. Overriding the identity lets us show
     * BOTH outcomes deliberately: a match for a customer funding their own
     * account, and a mismatch for someone funding from a stranger's.
     *
     * This controls what PLAID returns; it does not weaken our check.
     */
    ownerName?: string;
  } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    institution_id: opts.institutionId ?? 'ins_109508',
    initial_products: ['auth'],
    options: { webhook: process.env.APP_BASE_URL + '/api/webhooks/plaid' },
  };

  if (opts.ownerName) {
    // Plaid's sandbox custom-user mechanism: the "password" is a JSON config
    // describing the accounts and identity the sandbox should present.
    body.options = {
      ...(body.options as Record<string, unknown>),
      override_username: 'user_custom',
      // Only `override_accounts` is accepted at the top level. An earlier
      // version added `version` and `seed` and Plaid rejected the whole config
      // with INVALID_CREDENTIALS, which is a confusing error for a schema
      // problem — worth knowing if this ever needs changing again.
      override_password: JSON.stringify({
        override_accounts: [
          {
            type: 'depository',
            subtype: 'checking',
            starting_balance: 50_000,
            meta: { name: 'Everyday Checking' },
            numbers: { account: '1111222233330000', ach_routing: '011401533' },
            identity: {
              names: [opts.ownerName],
              addresses: [
                {
                  primary: true,
                  data: {
                    city: 'San Mateo',
                    region: 'CA',
                    street: '20 N San Mateo Dr',
                    postal_code: '94401',
                    country: 'US',
                  },
                },
              ],
              phone_numbers: [],
              emails: [],
            },
          },
        ],
      }),
    };
  }

  const result = await call<{ public_token: string }>(
    '/sandbox/public_token/create',
    body,
  );
  return result.public_token;
}

/** Ask Plaid's sandbox to fire a webhook at us, so the inbox has real traffic. */
export async function sandboxFireWebhook(
  accessToken: string,
  code = 'DEFAULT_UPDATE',
): Promise<void> {
  await call('/sandbox/item/fire_webhook', {
    access_token: accessToken,
    webhook_code: code,
  });
}

export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await call<{ total: number }>('/institutions/get', {
      count: 1,
      offset: 0,
      country_codes: ['US'],
    });
    return { ok: true, detail: `${result.total} sandbox institutions reachable` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
