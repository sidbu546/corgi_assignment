/**
 * /signup — open an account, in the browser, from nothing.
 *
 * WHY THIS EXISTS, given there are already seeded demo customers.
 *
 * Two reasons, and the second is the one that matters.
 *
 * 1. "Onboard with a real KYC check" is the first step of the brief, and until
 *    now it could only be done from a terminal script. A reviewer could watch
 *    KYC change on a customer who already existed, which is not the same thing
 *    as watching an account come into being.
 *
 * 2. Alpaca allows ONE ACH transfer per account per trading day. Every seeded
 *    customer has spent theirs, so on a quiet Saturday the deposit step returns
 *    422 for all of them and the money path simply cannot be walked. A new
 *    customer gets a new Alpaca account, and a new account has its own
 *    allowance. This is not a workaround: it is how the constraint is actually
 *    escaped, and it is the same path a real first-time customer takes.
 *
 * The customer created here is UNVERIFIED. No brokerage account, no bank, no
 * ability to move a cent until Persona approves them — the gate in
 * onboarding.ts applies to them exactly as it does to everyone else. That is
 * the point: the next screen shows a real gate, shut.
 */

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { transaction } from '@/lib/db';
import { SESSION_COOKIE, encodeSession, hashPassword } from '@/lib/auth';
import { currentUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-strong)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 13,
};

async function signup(formData: FormData) {
  'use server';

  const legalName = String(formData.get('legalName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!legalName || !email || password.length < 6) {
    redirect('/signup?error=invalid');
  }

  let session: Parameters<typeof encodeSession>[0];

  try {
    session = await transaction(async (client) => {
      const { rows: existing } = await client.query(
        `SELECT 1 FROM users WHERE lower(email) = $1`,
        [email],
      );
      if (existing.length > 0) throw new Error('taken');

      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO customers (legal_name, email) VALUES ($1, $2) RETURNING id`,
        [legalName, email],
      );
      const customerId = created[0].id;

      const { rows: users } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, display_name, customer_id)
         VALUES ($1, $2, 'customer', $3, $4::uuid)
         RETURNING id`,
        [email, await hashPassword(password), legalName, customerId],
      );

      return {
        userId: users[0].id,
        email,
        role: 'customer' as const,
        displayName: legalName,
        customerId,
      };
    });
  } catch (error) {
    redirect(
      `/signup?error=${error instanceof Error && error.message === 'taken' ? 'taken' : 'failed'}`,
    );
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 12 * 60 * 60,
  });

  redirect('/portfolio');
}

const ERRORS: Record<string, string> = {
  taken: 'that email already has an account',
  invalid: 'name, email and a password of at least 6 characters are required',
  failed: 'could not create the account',
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const existing = await currentUser();
  if (existing) redirect(existing.role === 'ops' ? '/ops' : '/portfolio');

  const params = await searchParams;
  // A distinct default so repeated demo runs do not collide on the email.
  const suggestion = `demo.${Date.now().toString(36)}@demo.ledgerly.app`;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1>Open an account</h1>
      <p className="lede">
        This is step one of the money path, and it starts with nothing. The
        account you create here cannot move a cent until Persona has verified
        it — the next screen shows that gate, shut.
      </p>

      <div className="grid grid-2">
        <form action={signup} className="card">
          {params.error && (
            <div
              className="badge badge-down"
              style={{ marginBottom: 12, display: 'inline-flex' }}
            >
              {ERRORS[params.error] ?? 'could not create the account'}
            </div>
          )}

          <label style={{ display: 'block', marginBottom: 10 }}>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Full legal name
            </div>
            <input name="legalName" required defaultValue="Jordan Avery" style={INPUT} />
          </label>

          <label style={{ display: 'block', marginBottom: 10 }}>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Email
            </div>
            <input
              name="email"
              type="email"
              required
              defaultValue={suggestion}
              style={INPUT}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 14 }}>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Password
            </div>
            <input
              name="password"
              type="password"
              required
              defaultValue="demo-password"
              style={INPUT}
            />
          </label>

          <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
            Open the account
          </button>

          <p className="dim" style={{ fontSize: 12, margin: '12px 0 0' }}>
            Use a made-up name. The identity submitted to the provider sandboxes
            is fictional and generated for you — never feed real personal data
            into a demo, this one included.
          </p>
        </form>

        <div className="card">
          <strong style={{ fontSize: 13 }}>What happens next, and why start here</strong>

          <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>
            Alpaca allows <strong>one ACH transfer per account per trading
            day</strong>. Every seeded demo customer has already spent theirs, so
            a deposit for any of them is refused with a 422 until the rail
            settles the last one. A new account has its own allowance, which is
            why walking the path from a fresh customer works when reusing an old
            one does not.
          </p>

          <p className="dim" style={{ fontSize: 12.5 }}>
            That refusal is shown rather than hidden — you can see it on{' '}
            <span className="mono">/fund</span> under &ldquo;what the providers
            actually said&rdquo;. A limit you can read is a working integration;
            a limit you cannot is a mock.
          </p>

          <div className="table-wrap" style={{ marginTop: 12, border: 'none' }}>
            <table>
              <tbody>
                {[
                  ['1 · here', 'account exists, unverified, gate shut'],
                  ['2 · /portfolio', 'real Persona inquiry, then approved'],
                  ['3 · /fund', 'real Plaid bank link, real Alpaca ACH relationship'],
                  ['4 · /fund', 'deposit — money in flight, not investable'],
                  ['5 · /ops', 'the rail reports good funds; it becomes investable'],
                  ['6 · /fund', 'buy the model — real orders at the paper venue'],
                ].map(([step, what]) => (
                  <tr key={step}>
                    <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {step}
                    </td>
                    <td className="dim" style={{ fontSize: 12 }}>
                      {what}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
            Already have one? <a href="/login">Sign in</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
