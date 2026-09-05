import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { queryOne } from '@/lib/db';
import { SESSION_COOKIE, encodeSession, verifyPassword } from '@/lib/auth';
import { currentUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'customer' | 'ops';
  display_name: string;
  customer_id: string | null;
}

async function login(formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  const user = await queryOne<UserRow>(
    `SELECT id, email, password_hash, role, display_name, customer_id
       FROM users WHERE lower(email) = $1`,
    [email],
  );

  // Same message and roughly the same work whether the account exists or not:
  // "no such user" versus "wrong password" is a free account-enumeration oracle.
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) {
    redirect('/login?error=1');
  }

  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    encodeSession({
      userId: user.id,
      email: user.email,
      role: user.role,
      displayName: user.display_name,
      customerId: user.customer_id,
    }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 12 * 60 * 60,
    },
  );

  redirect(user.role === 'ops' ? '/ops' : '/portfolio');
}

const DEMO_LOGINS = [
  { email: 'dana@demo.ledgerly.app', password: 'demo-password', note: 'Customer — funded, two deposits, a FIFO sell' },
  { email: 'marcus@demo.ledgerly.app', password: 'demo-password', note: 'Customer — funded, Balanced model' },
  { email: 'priya@demo.ledgerly.app', password: 'demo-password', note: 'Customer — KYC PENDING, cannot transact' },
  { email: 'alex@demo.ledgerly.app', password: 'demo-password', note: 'Customer — KYC REJECTED, cannot transact' },
  { email: 'ops@demo.ledgerly.app', password: 'ops-password', note: 'Ops — maker (proposes)' },
  { email: 'approver@demo.ledgerly.app', password: 'ops-password', note: 'Ops — checker (approves)' },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const existing = await currentUser();
  if (existing) redirect(existing.role === 'ops' ? '/ops' : '/portfolio');

  const params = await searchParams;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1>Sign in</h1>
      <p className="lede">
        Two roles, six demo logins. Nothing here is real: sandbox credentials,
        test identities, no real money and no real personal data.
      </p>

      <div className="grid grid-2">
        <form action={login} className="card">
          {params.error && (
            <div
              className="badge badge-down"
              style={{ marginBottom: 12, display: 'inline-flex' }}
            >
              email or password not recognised
            </div>
          )}

          <label style={{ display: 'block', marginBottom: 10 }}>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Email
            </div>
            <input
              name="email"
              type="email"
              required
              defaultValue="dana@demo.ledgerly.app"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                fontSize: 13,
              }}
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
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                fontSize: 13,
              }}
            />
          </label>

          <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
            Sign in
          </button>

          <p className="dim" style={{ fontSize: 12, margin: '12px 0 0' }}>
            Passwords are scrypt-hashed with a per-user salt and compared in
            constant time. The session cookie is HMAC-signed, httpOnly and expires
            in 12 hours.
          </p>
        </form>

        <div className="card">
          <strong style={{ fontSize: 13 }}>Demo logins</strong>
          <div className="table-wrap" style={{ marginTop: 10, border: 'none' }}>
            <table>
              <tbody>
                {DEMO_LOGINS.map((l) => (
                  <tr key={l.email}>
                    <td>
                      <div className="mono" style={{ fontSize: 12 }}>
                        {l.email}
                      </div>
                      <div className="mono dim" style={{ fontSize: 11.5 }}>
                        {l.password}
                      </div>
                      <div className="dim" style={{ fontSize: 12 }}>
                        {l.note}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
