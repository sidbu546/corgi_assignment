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
| **Evidence pack** | [`evidence/`](evidence/) — each provider's own dashboard, with what each capture proves |

### Pages worth opening first

| Page | Why it matters |
|---|---|
| [`/flow`](https://corgi-assignment.vercel.app/flow) | **Start here.** The six steps of the brief as one story for one customer — each with the **provider's own identifier** next to the journal entries it produced. |
| [`/invariants`](https://corgi-assignment.vercel.app/invariants) | Attempts every forbidden operation against the **production database, on that request**, and shows Postgres refusing each one. Runs in a rolled-back transaction, so opening it changes nothing. |
| [`/integrations`](https://corgi-assignment.vercel.app/integrations) | Live-vs-simulated labelling, with a **real HTTP probe** of each live provider performed when the page loads. |
| [`/ledger`](https://corgi-assignment.vercel.app/ledger) | The journal, with `effective_at` beside `recorded_at` on every entry, and the trial balance netting to zero per commodity. |
| [`/webhooks`](https://corgi-assignment.vercel.app/webhooks) | **Public, no sign-in.** Every inbound delivery with its signature verdict and how many times it arrived. |
| [`/restatements`](https://corgi-assignment.vercel.app/restatements) | Two buttons that are the point of the page: a **corrected close**, which must move the return, and a **2-for-1 split**, which must not. Both measured either side of the same transaction. |
| [`/recon`](https://corgi-assignment.vercel.app/recon) | The morning reconciliation, runnable on the spot — clean, then with breaks planted, so the classifier can be watched rather than described. |
| [`/asof`](https://corgi-assignment.vercel.app/asof) | The two time axes, made movable: today, a past date **as we know it now**, and the same date **as we knew it then** — side by side, with the late-arriving facts that separate the last two. The firm trial balance is proved at each coordinate, not just today. |

### Demo credentials

Sign in at **https://corgi-assignment.vercel.app/login** — the logins are also
listed on that page.

| Role | Email | Password | What it shows |
|---|---|---|---|
| **Customer** | `dana@demo.ledgerly.app` | `demo-password` | Funded. Two deposits, a Growth model, a FIFO sell across two lots, dividends. |
| Customer | `marcus@demo.ledgerly.app` | `demo-password` | Funded, Balanced model. |
| Customer | `priya@demo.ledgerly.app` | `demo-password` | Seeded as a **gated** customer — see the note below. |
| Customer | `alex@demo.ledgerly.app` | `demo-password` | Seeded as a **gated** customer — see the note below. |
| **Ops** | `ops@demo.ledgerly.app` | `ops-password` | Ops console. The *maker*. |
| Ops | `approver@demo.ledgerly.app` | `ops-password` | Ops console. The *checker* — a different identity, because nobody approves their own action. |

Two gated customers are seeded on purpose: the brief asks for pending and
rejected to be visible, not just the happy path.

**Which customer is in which KYC state is Persona's to say, not this file's.**
The controls on `/portfolio` call *Persona's own* sandbox endpoints, so pressing
them really does move a customer — and Persona's sandbox moves them unprompted
too: it declined a customer eight seconds after we restored her. So this table
deliberately does not name a state it cannot guarantee. The **sign-in page reads
each customer's current status live** and renders it beside the credentials,
using the same ordering the gate enforces, so what you see there is what the
gate will do. `npm run seed -- --reset` restores the seeded lot. Anyone can
also open a brand-new account at
[`/signup`](https://corgi-assignment.vercel.app/signup) and walk the whole path
from nothing, which is the better demo: a new customer gets a new brokerage
account, and Alpaca's one-ACH-per-account-per-trading-day limit means a
customer who has already deposited cannot deposit again today.
`npm run demo-ready` says who can.

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
| Brokerage & custody | Alpaca **Broker API** sandbox | 🟢 **LIVE** | A brokerage account **per customer**, in their own name. Real accounts, real ACH relationships, real orders. |
| Brokerage — execution venue | Alpaca **Trading API paper** | 🟢 **LIVE** | A second real sandbox, pre-funded, so orders reach a broker while ACH settles. **One shared OMNIBUS account** — labelled on every order. |
| Identity (KYC) | Persona sandbox | 🟢 **LIVE** | Real hosted inquiry flow and **real signed webhooks**. Approved / pending / declined all reachable. |
| Bank linking & funding | Plaid sandbox | 🟢 **LIVE** | Real Link flow, real auth + identity. The account owner is checked against the identity on file before funding. |
| Market data | Built in-house | 🟡 **SIMULATED** | Broker sandbox keys are **not entitled** to Alpaca's market data API (401 on every auth form). The brief permits this slot to be simulated. Owning it is also what makes a **corrected close on demand** possible. |
| Custodian file | Built in-house | 🟡 **SIMULATED** | Ships the morning positions/cash/transactions file and deliberately generates the late dividend and a tampered position. |
| **ACH settlement notification** | Built in-house | 🟡 **SIMULATED** | The deposit is **live** — Plaid-verified ACH relationship, real Alpaca transfer, real transfer id, held at `SENT_TO_CLEARING`. Simulated is **only Alpaca telling us it completed**, which its sandbox does on trading days only. Entries say so *in the ledger*: kind `deposit.settled.simulated`, source `simulator:rail`. |
| ACH returns | Built in-house | 🟡 **SIMULATED** | Plaid originates the deposit but will not bounce it days later with an R01. The simulator produces the return. |
| **Withdrawal — money out to the bank** | Alpaca **Broker API** sandbox | 🟣 **LIVE · REFUSED** | Every execution really does `POST` an OUTGOING ACH, and Alpaca really does refuse it: `403 forbidden`. Neither "live" nor "simulated" is honest — the call is real, the leg does not complete — so it has its own mode and its own colour. Tested rather than assumed: an *unknown* relationship id returns the same 403, so the **direction** is refused before the request is read, while INCOMING answers 422 with a specific business error. The refusal is written verbatim into the journal entry. |

**On the omnibus venue, stated plainly:** the paper account is one account
shared by every customer routed to it — the broker cannot tell them apart. Every
order records which venue executed it (`orders.venue`), and the API says
`omnibus: true`. This *sharpens* the case for reconciliation rather than
weakening it: in an omnibus arrangement, our ledger is the only record of who
owns what.

The brief requires **at least two** live integrations. This has **four**, across three providers.

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

All three are on one screen — [`/asof`](https://corgi-assignment.vercel.app/asof)
— side by side for the same customer, with the late-arriving facts that separate
the last two listed underneath. A claim like "we are bitemporal" that can only be
checked by reading a type signature is a claim a reviewer should refuse to take
on trust.

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
| **Corporate actions** | A **2-for-1 split** doubles units, halves the price, and must move **nothing else**. The entry has *no USD line at all*, so total basis cannot drift and per-unit basis halves as arithmetic rather than as a write. New units face `equity:external:market`, never the bank, or they would classify as an external flow and the return would jump. Tax lots are **closed and replaced** via `replaces_lot_id`, never mutated. `npm run split-test` measures every figure either side and compares the return at **twelve** decimal places, because two different returns can print identically at two. |
| **Maker-checker** | One rule, no branch: the **maker raises**, a **different person** approves *and* executes. Money-out enters the queue only **above the threshold**, so there is no second band behaving differently. Asking an agent to raise it does not launder it — the console records who triggered the agent, and that person is barred from deciding, by `CHECK` constraint. |

---

## Proving it rather than claiming it

```
npm run verify     # 32 invariants, against the real database
npm test           # 78 unit tests, no database required
```

`npm run verify` and [`/invariants`](https://corgi-assignment.vercel.app/invariants)
run **the same module**, so the page cannot drift into claiming something the CLI
does not test. Current state: **32/32 holding, 78/78 tests passing.**

What it proves, by attempting each and requiring refusal:

- unbalanced entries; entries balanced in USD but not in units; single-legged entries
- USD lines carrying units; instrument lines carrying cents
- house accounts carrying a customer id; customer accounts missing one
- `UPDATE`, `DELETE` and `TRUNCATE` on journal rows, prices and tax lots
- self-approval, self-**execution**, and approving what you asked an agent to raise — all `CHECK` constraints, not code paths
- the approval threshold itself, probed at its exact boundary **from the TypeScript constant**, so the constant and the constraint cannot drift apart

And one that proves an ordering rather than a refusal: a Persona decline
delivered **before its own creation event** must still gate the customer. Real
out-of-order delivery made the newest-by-arrival event `pending`, softening a
hard block to a soft one — a KYC gate failing *open*. The probe replays that
delivery, runs `kycStatus()`'s query character for character, and also asserts
that ordering by arrival gives the wrong answer, so the check cannot pass for
free.

`TRUNCATE` gets its own statement trigger because it bypasses row-level
triggers — the gap most people leave open.

---

## Architecture

```
db/migrations/     12 hand-written files, ~1,350 lines. The ledger core is ~250
                   lines I can read aloud; the rest is domain and constraints.
db/migrate.ts      checksums applied migrations to catch edits to applied files
src/lib/money.ts   Cents (bigint) | Units (Decimal 6dp) | the rounding rule
src/lib/ledger/    post · read (the bitemporal coordinate) · lots · trades · invariants
src/lib/returns.ts time-weighted return, pure and testable
src/lib/performance.ts  the daily series that feeds it
src/lib/valuation.ts    daily book value, with stale-price handling
src/lib/restatement.ts  as-published vs as-corrected, from one function
src/lib/recon.ts        break classification and aging
src/lib/calendar.ts     market days, T+1, and the New York day boundary
src/lib/corporate-actions.ts  splits: apply, and withdraw
src/lib/approvals.ts    maker-checker, threshold, execution
src/lib/providers/ registry (live/simulated/blocked + kill switch) · alpaca ·
                   plaid · persona · custodian · marketdata · brokerage
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
[`.env.example`](.env.example), verified against `grep -r process.env` so it
cannot drift from what the code reads. All credentials are sandbox/test-mode only.

Useful while demonstrating it:

```bash
npm run demo-ready     # who can deposit right now, and why not
npm run browser-path   # the loop through the real HTTP routes, on the deployed app
npm run evidence       # what the PROVIDERS say exists, without reading our database
npm run split-test     # a 2-for-1 split, measured either side, rolled back
npm run happy-path     # the whole core loop for a brand-new customer
```

`npm run demo-ready` exists because of a limit that shapes every demo: Alpaca
allows **one ACH transfer per account per trading day**, and a
`SENT_TO_CLEARING` transfer cannot be cancelled. A customer who has deposited
today cannot deposit again today. It asks Alpaca directly rather than inferring
from our own records.

---

## Status — what is built, what is not

Kept current rather than aspirational. The same table is rendered on the
[deployed overview page](https://corgi-assignment.vercel.app).

**Built**

| | Proof you can run |
|---|---|
| Multi-commodity double-entry ledger, bitemporal, append-only | `npm run verify` — 32/32 |
| As-of time travel: balances as at a past date, as published *and* as revised | [`/asof`](https://corgi-assignment.vercel.app/asof) — the trial balance is proved at each historical instant |
| Out-of-order provider delivery cannot fail a KYC gate open | `npm run verify` — replays the decline that arrived before its own creation |
| Money primitives, deterministic penny | `npm test` — 78 tests in total |
| Tax lots, FIFO, realised gain, basis-drift proof | `npm test` |
| Time-weighted return, flows structurally excluded | `npm test` — 10 tests pin the flow rule alone |
| Market calendar, T+1 settlement across holidays | `npm test` |
| Webhooks: signed, idempotent, replay-proof | `npm run replay-test` — 6/6 |
| Event bridge — 3 Alpaca SSE streams, **no polling** | `npm run bridge` |
| KYC onboarding — real Persona inquiry + webhooks | `npx tsx scripts/smoke-kyc.ts` — approved **and** declined |
| Open banking — Plaid Link, owner check, ACH deposit | `npx tsx scripts/smoke-funding.ts` |
| Daily valuation with stale-price handling | `npm run value` |
| Custodian simulator + **classified** reconciliation | `npm run recon` / `--plant` |
| Restatement — as-published vs as-corrected | `npm run restate` — 9/9 |
| Auth, customer portfolio, ops console | `npx tsx scripts/smoke-ui.ts` — 26/26, against the **deployed** app |
| Seed from zero | `npm run seed -- --reset` |
| MCP agent surface — 3 read tools, 1 write tool | `npm run mcp` (stdio) · `npm run agent-demo` — 14/14 |
| Maker-checker on money-out, with execution | `npm run agent-demo` |
| **The whole core loop, one command** | **`npm run happy-path`** — onboard, KYC, link, deposit, refusal, value, reconcile |
| The core loop **through the HTTP routes a reviewer clicks** | `npm run browser-path` — 12/12 |
| Corporate actions — a 2-for-1 split that moves nothing | `npm run split-test` — 16/16, rolls back unless given `--commit` |

**Blocked (not by us)**

- **A filled Alpaca order.** Orders are submitted for real and are correctly
  refused before settlement. Alpaca's sandbox settles ACH on *trading days*
  (`allow_instant_ach=false`, incoming wires refused by the API, no firm account
  exposed to journal from), and market orders fill in market hours. When funds
  land, the bridge books them and the fill path runs unchanged — it is already
  built and replay-tested.
- **An outgoing ACH.** Withdrawals are approved, executed and booked, and the
  transfer is genuinely attempted at Alpaca every time. Alpaca refuses the
  **direction** for these Broker sandbox credentials — established by test, not
  assumed: an unknown relationship id returns the same `403`, while INCOMING on
  the same account answers with a specific business error. So the money moves on
  our books and not on the rail, and the entry says exactly that rather than
  implying an ACH that does not exist.

**Not yet built**

- Installment/recurring deposits, and the second product line — see the cut list.

---

## The agent surface

A working MCP server over stdio: `npm run mcp`. Three read tools and one write
tool.

| Tool | Kind | What it does |
|---|---|---|
| `get_portfolio` | read | Positions, cost basis, the three cash buckets, time-weighted return |
| `explain_balance` | read | The journal lines behind a figure, so an agent can *check* a number rather than trust it |
| `list_reconciliation_breaks` | read | Open breaks, classified and aged. It cannot resolve one. |
| `propose_withdrawal` | **write** | Creates a **pending approval**. No journal entry, no transfer, no money. |

Wire it into a client with:

```json
{ "mcpServers": { "ledgerly": {
    "command": "npx", "args": ["tsx", "scripts/mcp-server.ts"],
    "cwd": "/absolute/path/to/corgi_assignment" } } }
```

### Operations I would never hand an autonomous agent

The rule: **an agent may read anything and propose anything, but may not
decide, move, or erase.**

| Never | Why |
|---|---|
| Approve or execute anything | Maker-checker collapses the moment the maker can also check. An agent that can approve its own proposal is an unsupervised agent with extra steps. |
| Move money out | Irreversible, unbounded failure mode. Proposing is safe because a human sees the amount and destination first. |
| Place an order directly | A fill is irreversible. A mispriced order cannot be recalled, and "the model said so" is not a defence to a customer. |
| Write a journal entry | The ledger is the record of truth. Anything that writes to it unsupervised can rewrite what is true. |
| Issue a corrected price or restate a figure | A restatement changes what a customer was *told*. That carries regulatory weight and needs a human name on it. |
| Change KYC status | The gate exists to stop unverified people moving money. An agent that can open it has removed the control. |
| Disable a provider | An operational decision with direct customer impact. |
| Resolve a reconciliation break | Reading breaks is useful; closing them is how a genuine break gets buried. |

These are **absent from the surface**, not merely guarded — there is no function
to call. Enforcement is layered: the tool surface has no such function; every
proposal is stamped `requested_by_kind = 'agent'`; `approvals_no_self_approval`
is a **CHECK constraint** so the database refuses self-approval even from psql;
and the executor refuses any decider or executor identity prefixed `agent:`.

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

- **Sandbox ACH settles on trading days, not on a timer.** A deposit initiated
  at a weekend stays in flight until the market reopens, so a live demo cannot
  fund an account from zero and watch it clear. The in-flight state is modelled
  as a first-class ledger position rather than hidden behind a spinner, and the
  ops console can deliver the settlement notification the rail will eventually
  send — labelled in the ledger itself as `deposit.settled.simulated`, source
  `simulator:rail`, so the record never claims Alpaca said something it did not.
- **Alpaca is asynchronous in three places** — account approval, ACH relationship
  approval, and transfer settlement. All three are states the product must model
  anyway, and the sandbox handed them over for free.
- **This README describes what exists.** Where something is unbuilt it is listed
  as unbuilt, above.
