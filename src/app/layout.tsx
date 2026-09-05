import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ledgerly — investment platform',
  description:
    'Retail investing on an append-only, bitemporal, multi-commodity ledger. ' +
    'Corgi trial, Track 2.',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/invariants', label: 'Invariants' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/ledger', label: 'Ledger' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
              {NAV.map((item) => (
                <a key={item.href} href={item.href}>
                  {item.label}
                </a>
              ))}
            </nav>
            <span className="spacer" />
            <span className="badge badge-info" title="No real money, no real PII">
              Sandbox
            </span>
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
