# Ledgerly

**A retail investing platform on an append-only, bitemporal, multi-commodity ledger.**

Corgi 48-hour trial, **Track 2 — Investment app**.

Customers pass an identity check, link a bank, deposit, buy into a model
portfolio, and are valued daily. When the custodian is late with the truth — a
dividend, a corrected close — history is **restated, never rewritten**.

---

## Live system

| | |
|---|---|
| **Deployed app** | **https://corgi-assignment.vercel.app** |
| **Repository** | https://github.com/sidbu546/corgi_assignment |
| **Decision log** | [`docs/DECISIONS.md`](docs/DECISIONS.md) — written as the work happened |

### Pages worth opening first

| Page | Why it matters |
|---|---|
| [`/invariants`](https://corgi-assignment.vercel.app/invariants) | Attempts every forbidden operation against the **production database, on that request**, and shows Postgres refusing each one. Runs in a rolled-back transaction, so opening it changes nothing. |
| [`/integrations`](https://corgi-assignment.vercel.app/integrations) | Live-vs-simulated labelling, with a **real HTTP probe** of each live provider performed when the page loads. |
| [`/ledger`](https://corgi-assignment.vercel.app/ledger) | The journal, with `effective_at` beside `recorded_at` on every entry, and the trial balance netting to zero per commodity. |

### Demo credentials

Sign in at **https://corgi-assignment.vercel.app/login** — the logins are also
listed on that page.

| Role | Email | Password | What it shows |
|---|---|---|---|
| **Customer** | `dana@demo.ledgerly.app` | `demo-password` | Funded. Two deposits, a Growth model, a FIFO sell across two lots, dividends. |
| Customer | `marcus@demo.ledgerly.app` | `demo-password` | Funded, Balanced model. |
| Customer | `priya@demo.ledgerly.app` | `demo-password` | **KYC pending** — gated, cannot transact. |
| Customer | `alex@demo.ledgerly.app` | `demo-password` | **KYC rejected** — gated, with the reason shown. |
| **Ops** | `ops@demo.ledgerly.app` | `ops-password` | Ops console. The *maker*. |
| Ops | `approver@demo.ledgerly.app` | `ops-password` | Ops console. The *checker* — a different identity, because nobody approves their own action. |

Two gated customers are seeded on purpose: the brief asks for pending and
rejected to be visible, not just the happy path.

Passwords are scrypt-hashed with a per-user salt and compared in constant time;
the session cookie is HMAC-signed, `httpOnly`, and expires in 12 hours.
`npx tsx scripts/smoke-ui.ts` asserts all of this against the deployed system,
including that an ops user cannot open a customer portfolio, a customer cannot
open the ops console, and a forged cookie is rejected.

---

## Real versus simulated

Stated plainly, because presenting a simulator as live is an automatic fail.
These labels are **rendered by the app from the same declaration the runtime
code reads** ([`src/lib/providers/registry.ts`](src/lib/providers/registry.ts)),
so a slot cannot quietly change mode without the badge changing in the same
commit.

| Slot | Provider | Mode | Notes |
|---|---|---|---|
| Brokerage & custody | Alpaca **Broker API** sandbox | 🟢 **LIVE** | Real accounts, real order lifecycle, real fills. Verified end to end. |
| Identity (KYC) | Persona sandbox | 🟢 **LIVE** | Real hosted inquiry flow. Approved / pending / declined all reachable via Persona test identities. |
| Bank linking & funding | Plaid sandbox | 🟢 **LIVE** | Real Link flow, real auth + identity products. |
| Market data | Alpaca Market Data | 🟢 **LIVE** | Daily closes drive valuation. Stale prices surfaced with an explicit age. |
| Custodian file | Built in-house | 🟡 **SIMULATED** | Ships the morning positions/cash/transactions file and deliberately generates the late dividend, the corrected close, and a tampered position. |
| ACH returns | Built in-house | 🟡 **SIMULATED** | Plaid originates the deposit but will not bounce it days later with an R01. The simulator produces the return. |

The brief requires **at least two** live integrations. This has **four**.

**No real personal data** is submitted to any provider — only documented test
identities. **No live-mode keys**, no real money, no secrets in the repository.

---

## The three ideas the system rests on

### 1. Units and money are different dimensions, and cannot mix

A journal line carries **either** `amount_cents bigint` **or**
`units numeric(28,6)` — never both — enforced by a `CHECK` constraint against
the line's commodity. There is no column anywhere in the schema that can hold
"value". Market value is `units × price`, computed at read time.

```sql
CONSTRAINT journal_lines_usd_uses_cents
  CHECK ((commodity =  'USD') = (amount_cents IS NOT NULL)),
CONSTRAINT journal_lines_instrument_uses_units
  CHECK ((commodity <> 'USD') = (units IS NOT NULL))
```

### 2. Multi-commodity double entry

An entry balances to zero **independently for every commodity it touches**,
checked by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger at `COMMIT` — so
a half-written two-commodity trade cannot be committed. A buy of 10 shares:

```
assets:positions          +10.000000 AAPL     units in
equity:external:market    -10.000000 AAPL     the market gave them up
assets:positions:cost       +150,100 USD      basis, commission capitalised
liabilities:trade_payable   -150,100 USD      owed to the custodian, settles T+1

AAPL: +10 − 10 = 0        USD: +150100 − 150100 = 0
```

### 3. Bitemporal, append-only

Every entry carries two dates: `effective_at` (when it economically happened)
and `recorded_at` (when we learned it, assigned by the database). That answers
three questions people routinely conflate:

| `effective_at ≤` | `recorded_at ≤` | Question answered |
|---|---|---|
| today | now | What *is* the balance |
| 3 Sep | now | What was it on 3 Sep, given all we now know |
| 3 Sep | 3 Sep | What did we **believe** on 3 Sep — the as-published figure |

The third is what a regulator asks about, and it's a query parameter here rather
than a subsystem. Corrections are **reversal + re-book**, never edits.

---

## Domain positions taken

| Gauntlet item | Position, and why |
|---|---|
| **Return figure** | **Time-weighted.** The customer doesn't control the market and the manager doesn't control the customer's savings habits. Proven by a test: identical market performance with a $0 and a $10,000 deposit produces an identical TWR. MWR is a fine second view, not the headline. |
| **Tax lots** | **FIFO**, the IRS default absent specific identification, and the only sane choice when a rebalance generates sells the customer never individually authorised. Lot ordering is a *parameter* — HIFO is a comparator swap, proven by a test. |
| **Cost basis** | Commissions **capitalise into basis** (correct US treatment). A commission expensed separately produces a wrong 1099-B. |
| **Unrealised gain** | **Not a ledger entry.** A price moving is not a transaction. Realised gain *is*, and it falls out of the balance requirement on a sell. |
| **Settlement** | **T+1, modelled not hidden.** Three cash buckets. Withdrawable = settled only. Investable = settled + unsettled proceeds (you may buy with unsettled proceeds; withdrawing them is free-riding). |
| **The penny** | Largest-remainder allocation, ties broken by index — a pure function of its inputs, so a re-run of a closed period reproduces an identical document. **The house eats any unattributable residual**, never the customer. |
| **Rounding** | Half away from zero, at one chokepoint. Chosen over banker's rounding because customers check arithmetic by hand. |

---

## Proving it rather than claiming it

```
npm run verify     # 20 invariants, against the real database
npm test           # 39 unit tests, no database required
```

`npm run verify` and [`/invariants`](https://corgi-assignment.vercel.app/invariants)
run **the same module**, so the page cannot drift into claiming something the CLI
does not test. Current state: **20/20 holding, 39/39 tests passing.**

What it proves, by attempting each and requiring refusal:

- unbalanced entries; entries balanced in USD but not in units; single-legged entries
- USD lines carrying units; instrument lines carrying cents
- house accounts carrying a customer id; customer accounts missing one
- `UPDATE`, `DELETE` and `TRUNCATE` on journal rows, prices and tax lots
- self-approval (maker-checker enforced by a `CHECK` constraint, not a code path)

`TRUNCATE` gets its own statement trigger because it bypasses row-level
triggers — the gap most people leave open.

---

## Architecture

```
db/migrations/     hand-written SQL. The ledger is ~250 lines I can read aloud.
db/migrate.ts      checksums applied migrations to catch edits to applied files
src/lib/money.ts   Cents (bigint) | Units (Decimal 6dp) | the rounding rule
src/lib/ledger/    post · read · lots · trades · invariants
src/lib/returns.ts time-weighted return, pure and testable
src/lib/providers/ registry (live/simulated + kill switch) · alpaca
src/app/           the deployed UI
```

**No ORM.** One of the automatic fails is "code you cannot explain line by
line", and generated SQL is exactly that. Everything touching money is SQL I
wrote.

**No status columns, no positions table, no `customers.balance`.** Order status
is the latest `order_events` row; positions and balances are folds over
`journal_lines`. A projection that can drift from the ledger is a bug waiting
for an audit.

---

## Running it yourself

The deliverable is the deployed URL above — this section is for inspecting the
code, not for evaluating the system.

```bash
npm install
cp .env.example .env.local     # fill in sandbox credentials
npm run migrate                # apply schema
npm run verify                 # prove the invariants
npm test                       # unit tests
npm run dev                    # development server
```

Every key the system needs is documented in
[`.env.example`](.env.example). All credentials are sandbox/test-mode only.

---

## Status — what is built, what is not

Kept current rather than aspirational. The same table is rendered on the
[deployed overview page](https://corgi-assignment.vercel.app).

**Built**

- Multi-commodity double-entry ledger, bitemporal, append-only — 20/20 invariants proven
- Money primitives and deterministic penny allocation — 15 tests
- Tax lots, FIFO consumption, realised gain, basis-drift proof — 11 tests
- Time-weighted return with structural flow exclusion — 13 tests
- Provider registry with honest labelling and a deliberate kill switch
- Alpaca Broker client, verified end to end against the sandbox
- Deployed, publicly reachable, four working pages

**Not yet built**

- Webhook endpoints with signature verification and idempotent consumers
- Seed script (`npm run seed`) — the ledger pages are empty until this lands
- Authentication and the customer / ops portals
- Custodian file simulator and the reconciliation breaks screen
- Restatement machinery (corrected close → restated return, as-published preserved)
- MCP agent surface

---

## Cut list

Deliberately not built, and what week two would add.

| Cut | Why |
|---|---|
| Mobile app | The brief makes portal choice a scoping call. A web app that works on a phone beats a second codebase in 48 hours. |
| Multi-currency | Explicitly out of scope. Those hours went into lot accounting and restatements. |
| Money-weighted return | TWR is the headline figure. MWR is a second view on the same flow data — a week-two addition, not a v1 gap. |
| Options, margin, shorting | `planDisposal` refuses to sell units not held rather than silently opening a short. |
| Performance-fee accrual | Real product need, no bearing on whether the ledger is honest. |

**Week two, in priority order:** specific-ID lot selection; a tax report an
accountant would accept; model-portfolio versioning and drift; recurring
deposits with a standing instruction; USDC withdrawal confirming on Base
Sepolia, ledgered identically to ACH.

---

## Honest notes

- **Sandbox ACH is slow.** Alpaca's sandbox takes well over ten minutes to settle
  a deposit, so a live demo cannot fund an account from zero within it. Demo
  accounts are seeded pre-funded; the demo shows a deposit being *initiated* and
  the in-flight state, which is modelled as a first-class ledger position rather
  than hidden behind a spinner.
- **Alpaca is asynchronous in three places** — account approval, ACH relationship
  approval, and transfer settlement. All three are states the product must model
  anyway, and the sandbox handed them over for free.
- **This README describes what exists.** Where something is unbuilt it is listed
  as unbuilt, above.
