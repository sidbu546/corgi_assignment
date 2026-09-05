import { withClient } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { cashPosition } from '@/lib/ledger/read';
import { formatCents } from '@/lib/money';
import { activeBankLink, kycStatus, loadCustomer } from '@/lib/onboarding';
import FundClient from './FundClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function FundPage() {
  const session = await requireCustomer();

  const data = await withClient(async (client) => {
    const customer = await loadCustomer(client, session.customerId);
    const kyc = await kycStatus(client, customer.id);
    const link = await activeBankLink(client, customer.id);

    // A refused link is deactivated, so `activeBankLink` will not find it. Look
    // for the most recent attempt too, so the page can explain the refusal
    // rather than silently showing the "not linked" state as if nothing
    // happened.
    const { rows: lastAttempt } = await client.query<{
      institution: string;
      account_mask: string;
      account_name: string;
      name_match: boolean | null;
      alpaca_relationship_id: string | null;
    }>(
      `SELECT institution, account_mask, account_name, name_match,
              alpaca_relationship_id
         FROM bank_links WHERE customer_id = $1::uuid
        ORDER BY recorded_at DESC LIMIT 1`,
      [customer.id],
    );

    const { rows: models } = await client.query<{
      id: string;
      name: string;
      description: string;
      weights: Array<{ symbol: string; weight_bps: number }>;
    }>(
      `SELECT p.id, p.name, p.description,
              json_agg(json_build_object('symbol', w.symbol, 'weight_bps', w.weight_bps)
                       ORDER BY w.weight_bps DESC) AS weights
         FROM model_portfolios p
         JOIN model_versions v ON v.model_id = p.id AND v.version = 1
         JOIN model_weights w ON w.model_version_id = v.id
        GROUP BY p.id, p.name, p.description, p.risk_rank
        ORDER BY p.risk_rank`,
    );

    const cash = await cashPosition(customer.id);

    return {
      customer,
      kyc,
      link: link ?? lastAttempt[0] ?? null,
      models,
      investable: formatCents(cash.investable),
      pending: formatCents(cash.pendingDeposits),
      settled: formatCents(cash.settled),
    };
  });

  const canTransact = data.kyc.status === 'approved';

  return (
    <>
      <h1>Fund and invest</h1>
      <p className="lede">
        The core money path, on real rails. Plaid verifies the bank account and
        mints a token scoped to Alpaca; Alpaca redeems it and pulls the deposit on
        ACH; the model allocation becomes real notional orders at the broker. Both
        providers are live sandboxes, not simulators.
      </p>

      {!canTransact && (
        <div className="callout callout-warn">
          <p style={{ margin: 0 }}>
            <strong>Identity verification is {data.kyc.status}.</strong> Every button
            below is disabled — and more importantly, the server-side routes refuse
            too. The gate is enforced where the money moves, not in the UI. A
            disabled button is a courtesy to honest users; it is not a control.
          </p>
        </div>
      )}

      {data.customer.alpaca_account_id && (
        <p className="dim mono" style={{ fontSize: 12 }}>
          Alpaca brokerage account {data.customer.alpaca_account_id}
        </p>
      )}

      <FundClient
        models={data.models}
        bankLink={data.link}
        investable={data.investable}
        pending={data.pending}
        canTransact={canTransact}
      />

      <h2>Where the money is right now</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>Settled — withdrawable</td>
              <td className="num">{data.settled}</td>
            </tr>
            <tr>
              <td>Investable — settled plus unsettled sale proceeds</td>
              <td className="num">{data.investable}</td>
            </tr>
            <tr>
              <td>In flight — deposited, not yet good funds</td>
              <td className="num">{data.pending}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        Three numbers rather than one, because they genuinely differ and the
        difference is what a customer trips over. See{' '}
        <a href="/portfolio">the portfolio</a> for holdings and return, and{' '}
        <a href="/ledger">the ledger</a> for the entries behind every figure here.
      </p>
    </>
  );
}
