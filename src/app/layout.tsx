import type { Metadata } from 'next';
import './globals.css';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Ledgerly — investment platform',
  description:
    'Retail investing on an append-only, bitemporal, multi-commodity ledger. ' +
    'Corgi trial, Track 2.',
};

const PUBLIC_NAV = [
  { href: '/', label: 'Overview' },
  { href: '/invariants', label: 'Invariants' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/webhooks', label: 'Webhooks' },
];

const CUSTOMER_NAV = [
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/fund', label: 'Fund & invest' },
];
const OPS_NAV = [{ href: '/ops', label: 'Ops console' }];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  const roleNav = user
    ? user.role === 'ops'
      ? OPS_NAV
      : CUSTOMER_NAV
    : [];

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              <span className="brand-mark">L</span>
              <span>Ledgerly</span>
            </a>
            <nav className="nav">
              {[...roleNav, ...PUBLIC_NAV].map((item) => (
                <a key={item.href} href={item.href}>
                  {item.label}
                </a>
              ))}
            </nav>
            <span className="spacer" />
            <span className="badge badge-info" title="No real money, no real PII">
              Sandbox
            </span>
            {user ? (
              <>
                <span className="dim" style={{ fontSize: 12.5 }}>
                  {user.displayName}
                </span>
                <a className="btn" href="/logout" style={{ padding: '4px 10px' }}>
                  Sign out
                </a>
              </>
            ) : (
              <a className="btn btn-primary" href="/login" style={{ padding: '4px 12px' }}>
                Sign in
              </a>
            )}
          </header>

          <main>{children}</main>

          <footer>
            Every figure on every screen is derived from journal entries. Money is
            integer cents; positions are units to 6dp; the two never mix.
          </footer>
        </div>
      </body>
    </html>
  );
}
