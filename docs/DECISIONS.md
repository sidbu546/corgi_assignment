# Decision log

Append-only. Newest at the bottom. Every entry is written when the decision is
made, not reconstructed afterwards — the git history should corroborate the
timestamps.

Format: what I decided, why, what I assumed, what it costs me.

---

## 2026-09-05T16:48Z — Track 2, investment app

**Decided.** Track 2 over Track 1.

**Why.** Two reasons, one of them honest about incentives. First, the problem is
richer: the units-vs-money dimension split, time-weighted return under external
flows, FIFO lot consumption, and the restatement machinery are genuine
engineering problems with provable invariants, rather than careful bookkeeping.
Second, Track 1's brief says outright that it is Corgi's day job and the panel
has built every piece of it. That is the higher-ceiling choice and I considered
it seriously, but with 48 hours the variance is brutal: every shortcut is
visible to people who know exactly where to look.

**Cost.** Track 2 mandates three live integrations (Alpaca, KYC, Plaid) against
Track 1's two, and adds a dependency I do not control: US market hours gate real
fills. I am accepting more integration surface in exchange for a more
interesting core.

---

## 2026-09-05T16:52Z — Stack

**Decided.** Next.js 15 (App Router, TypeScript) on Vercel, Postgres on Neon,
`pg` with hand-written SQL for everything that touches money, Drizzle only for
convenience reads elsewhere.

**Why.** One deployment artefact serves the UI, the JSON API, the webhook
endpoints and the MCP surface, which matters when the clock is the binding
constraint. Vercel gives a public HTTPS URL immediately, and webhooks need a
public URL from hour one, not hour thirty.

Hand-written SQL for the ledger is a deliberate anti-convenience choice. One of
the automatic fails is "code you cannot explain line by line", and an ORM's
generated SQL is exactly the code you cannot explain under questioning. The
ledger is ~200 lines of SQL I wrote and can defend.

**Assumed.** Free tiers throughout. No spend, per the rules.

---

## 2026-09-05T16:55Z — The ledger is multi-commodity, not two ledgers

**Decided.** One journal. Every line carries a `commodity` (`'USD'` or a ticker)
and exactly one of `amount_cents bigint` or `units numeric(28,6)`, enforced by a
CHECK constraint. An entry must balance to zero **independently per commodity**,
enforced by a DEFERRED constraint trigger at COMMIT.

**Why.** The gauntlet's first item is that units and money are different
dimensions and mixing them is the classic day-one bug. The way to not make that
bug is to make it structurally unrepresentable: there is no column in this schema
that can hold "value", and no code path that can add cents to units, because
they are different columns with different types and a constraint that says only
one may be populated.

The alternative — two parallel ledgers, one for cash and one for stock — was
rejected because it cannot express a single atomic trade. A buy that debits
units and credits cash has to be *one* entry that balances, or it is two
bookkeeping records that can drift apart.

**The trick that makes it work.** The far leg of every trade is a house account,
`equity:external:market`, which is allowed to hold both dimensions. On a buy it
holds `-10 AAPL` and `+150,100 USD` on the same entry. Each commodity sums to
zero. The market gave us shares and took dollars, and the ledger says so
literally.

**Cost.** Slightly unusual to anyone expecting classic debit/credit columns. I
have documented the sign convention (assets and expenses positive, everything
else negative) in one place and it is relied on everywhere.

---

## 2026-09-05T16:58Z — Unrealised gain is not a ledger entry

**Decided.** Positions are carried in two accounts: `assets:positions` (units
only) and `assets:positions:cost` (cents only). Market value is **never**
stored in the ledger. Unrealised gain is computed at read time as
`(units x price) - cost`.

**Why.** Nothing has happened. A price moving is not a transaction, and booking
it as one would mean the ledger changes when nobody did anything, which destroys
the property that the ledger is a record of events. Realised gain, by contrast,
*is* an event, and it falls out of the balance requirement on a sell: proceeds
minus the basis of the consumed lots is whatever makes the entry sum to zero.

**Consequence I like.** I cannot accidentally double-count a gain, because there
is exactly one place it can come from.

---

## 2026-09-05T17:01Z — Commissions capitalise into cost basis

**Decided.** Trade commissions increase the cost basis of the lot rather than
being expensed to `expenses:fees`.

**Why.** That is the actual US tax treatment, and the tax export is a stated
deliverable. A commission expensed separately produces a basis that is wrong on
a 1099-B, which is the kind of error that is invisible in a demo and expensive in
production. `expenses:fees` remains for advisory and platform fees, which are
genuinely expenses.

---

## 2026-09-05T17:04Z — Cash is three buckets, not one

**Decided.** `assets:cash:settled`, `assets:cash:unsettled_proceeds`,
`assets:cash:pending_deposit`.

**Why.** T+1 settlement means settled and available cash diverge and re-converge,
and the gauntlet says to model the gap rather than hide it. The rule I am
implementing, which is the real US rule rather than a simplification:

- **Withdrawable** = settled cash only.
- **Investable** = settled + unsettled sale proceeds. You may buy with unsettled
  proceeds; withdrawing them is free-riding.
- **Deposits in flight are neither** until they are good funds.

That third bucket is also what makes the bounced-deposit scenario expressible:
the reversal has an account to come out of.

---

## 2026-09-05T17:07Z — Append-only is enforced by Postgres, twice

**Decided.** `BEFORE UPDATE OR DELETE` triggers that `RAISE EXCEPTION` on every
money table, plus `BEFORE TRUNCATE` statement triggers, plus (once the app role
exists) `REVOKE UPDATE, DELETE` from that role.

**Why.** "UPDATE or DELETE on money rows, anywhere, ever" is an automatic fail.
An immutability guarantee that lives in application code is not a guarantee, it
is a convention — one careless migration or one psql session away from being
false. Triggers fire for the table owner and for a superuser, so the property
holds regardless of who is connected.

TRUNCATE gets its own trigger because it bypasses row-level triggers entirely,
which is the gap most people leave open.

**Deliberate.** I intend to demonstrate this in the debrief by trying an UPDATE
live and letting Postgres refuse, rather than asserting it in a README.

---

## 2026-09-05T17:10Z — No status columns, no positions table

**Decided.** Orders have no `status` column. There is no `positions` table and no
`customers.balance`. Status is the latest `order_events` row; positions and
balances are folds over `journal_lines`.

**Why.** A projection that can drift from the ledger is a bug waiting for an
audit. If the balance on the screen is computed from the entries every time, then
"every balance on every screen is derivable from those entries" is true by
construction rather than by discipline — including as it stood on any past date,
which is the same query with a `recorded_at <=` predicate.

**Cost.** Slower reads. If this becomes a problem I will add materialised views
that are *derived*, clearly labelled as caches, and rebuildable from the journal
— not a second source of truth.

---

## 2026-09-05T17:13Z — Prices are superseded, never corrected in place

**Decided.** A corrected closing price inserts a **new** `prices` row for the
same `(symbol, price_date)` with a later `recorded_at` and a `supersedes_id`
pointer. Nothing is updated.

**Why.** This one decision is what makes the whole restatement requirement
tractable:

- **as published on date T** = latest price row where `recorded_at <= T`
- **as corrected now** = latest price row, full stop

Both are the same query with a different bound. The restatement machinery is
then not a special subsystem, it is a parameter. The valuation runs and published
returns follow the same pattern: a restated day inserts a new run for the same
`as_of_date`, and the original stays queryable forever.

---

## 2026-09-05T17:34Z — Correction: dropped Drizzle entirely

**Corrects the 16:52Z stack entry**, which said Drizzle would be kept "for
convenience reads elsewhere". It has been removed from the dependency tree.

**Why.** Once the ledger was written in raw SQL, the only thing Drizzle was
buying was typed reads on a handful of lookup tables — and it cost a schema
definition that would have to be kept in sync with the migrations by hand. Two
descriptions of one schema is exactly the drift problem I am trying to avoid
elsewhere in this system. Everything is now `pg` plus SQL I wrote.

**Noted rather than edited.** The original entry stays as written. A decision log
that gets quietly rewritten when a decision changes is worth nothing, which is
the same argument the ledger makes about corrections: reversal and re-book,
never an edit.

---

## 2026-09-05T18:20Z — Alpaca Broker API sandbox, not Trading API paper

**Decided.** Broker API sandbox (`broker-api.sandbox.alpaca.markets`) as the
brokerage/custody integration, with Legacy key/secret credentials over HTTP
Basic auth.

**Why.** Two reasons, and the first one is a hard requirement rather than a
preference.

The brief demands fills arriving "by webhook, not just polling". The Trading API
only offers a **websocket stream** for trade updates, which needs a long-lived
process — and this deploys to Vercel serverless, which cannot hold a socket
open. Satisfying the requirement on Trading API would have meant running a
separate always-on listener that forwards stream events into our own webhook
endpoint: a moving part that exists solely to work around the wrong provider
choice, and one more thing to fail live.

Second, Broker API gives **per-customer accounts** rather than one omnibus
paper account shared by every demo customer. A retail investing product where
each customer has their own brokerage account is the honest model, and it makes
reconciliation against the custodian mean something.

**Credential type.** Chose Legacy (key id + secret, Basic auth) over the newer
Client Secret credential, which is an OAuth2 client-credentials flow requiring a
token exchange, token caching and refresh-on-expiry. For a 48-hour build that is
three failure modes bought for no benefit.

**Assumed.** Alpaca sandbox accounts can be created without real PII, using
their documented test identities. If that turns out to be wrong I will fall back
to a single omnibus account and say so plainly in the README rather than
pretending each customer has their own.

---

## 2026-09-05T18:26Z — All three mandatory live integrations verified before building on them

**Decided.** Before writing a line of provider client code, hit each sandbox
with a real request and confirm a 200.

- **Alpaca Broker sandbox** — `GET /v1/accounts` 200, `GET /v1/assets/AAPL`
  returns the real instrument with `fractionable: true` (which matters: the
  model portfolios need fractional shares to hit target weights on small
  balances).
- **Plaid sandbox** — `POST /institutions/get` 200 with real institution data.
- **Persona sandbox** — `GET /api/v1/inquiries` 200.

**Why bother.** Because "integration reality" is 20 points and the failure mode
it is guarding against is a system that looks wired but was only ever tested
against a mock. Confirming credentials work at hour two costs ten minutes;
discovering at hour forty that a key was for the wrong environment costs the
trial. Build outside-in against reality, starting with proof that reality
answers.

---

## 2026-09-05T18:31Z — The invariants are proven, not asserted

**Decided.** `npm run verify` attempts every forbidden operation against the
real database and requires Postgres to refuse each one. 20 checks: unbalanced
entries, entries balanced in one commodity but not the other, single-legged
entries, USD lines carrying units, instrument lines carrying cents, house
accounts carrying a customer id, customer accounts missing one, zero-quantity
lines, UPDATE/DELETE/TRUNCATE on journal rows, UPDATE on prices and tax lots,
and self-approval.

It runs inside a transaction that is rolled back, with a savepoint around each
probe, so it can be run against the deployed database at any time — including
in front of the panel.

**Why.** A README that says "money rows are append-only" is a promise. This is
evidence, and it converts the most likely hostile question in the debrief
("prove it") into a command I can run while they watch.

**A real bug this caught in the harness itself.** My first version created the
savepoint *after* inserting the unbalanced lines, so rolling back left them in
the transaction and every subsequent probe tripped over the same poisoned entry.
Worth recording because it is exactly the class of error the deferred-constraint
design makes easy to write and hard to notice.

---

## 2026-09-05T18:45Z — Deployed early, before there was anything worth deploying

**Decided.** Get the public URL live at hour two with nothing but the scaffold on
it, rather than at hour thirty with a finished app.

**Why.** Every webhook in this system needs a public HTTPS endpoint. Until one
exists, no provider can deliver anything, which means the integration work
cannot even be tested. Deploying early converts "will it deploy" from an
end-of-project risk into a solved problem.

That paid for itself immediately. Two things were broken that would have been
much worse to discover late:

1. **Vercel Authentication was on by default**, returning a 302 to SSO for every
   request. Every webhook delivery would have bounced off an auth wall, and the
   deployment would have failed the "a URL we can open" requirement outright.
   Disabled via the projects API (`ssoProtection: null`).
2. **The project had `framework: null`.** Vercel had not detected Next.js and
   was serving the repo as static files, so the root returned a platform 404
   even though the app built cleanly. Set to `nextjs` and redeployed.

**Live at** https://corgi-assignment.vercel.app — HTTP 200, no auth wall.

---

## 2026-09-05T18:52Z — Alpaca sandbox is asynchronous in three places, and that is useful

**Observed, not decided.** Running the brokerage rail end to end for real
surfaced three asynchronous steps that a mock would have hidden:

1. **Account approval.** A new account is `SUBMITTED`, moves to `APPROVED`, then
   `ACTIVE`, taking around 30-40 seconds. Alpaca will not settle funds into an
   account that is not ACTIVE.
2. **ACH relationship approval.** The relationship is `QUEUED` before it is
   `APPROVED`. My first attempt created a transfer against a QUEUED
   relationship, and it sat in QUEUED indefinitely — the transfer was never
   going to move, and nothing said so.
3. **Transfer settlement.** `QUEUED` -> `SENT_TO_CLEARING` -> and then a wait
   that is longer than ten minutes. Sandbox is simulating real ACH timing.

**Why this is good news.** All three are states the product has to model anyway.
A customer who has signed up but cannot yet be funded is the KYC pending state.
A deposit that is in flight but not good funds is exactly what
`assets:cash:pending_deposit` exists for. The sandbox is handing me the awkward
cases for free.

**What it costs.** A live demo cannot wait on sandbox ACH. Mitigation is to seed
demo accounts ahead of time so they are already funded, and to keep the
in-flight deposit visible as a first-class state rather than something to hide
behind a spinner. A background watcher is recording the true settlement time so
the demo script can be planned around a real number rather than a guess.

**Also fixed.** Alpaca rejects SSN area 000, 666 and 900-999. The first smoke
run used 666 and got a 422. Test identities are now generated inside the valid
range.

---

## 2026-09-05T19:20Z — The invariant suite is a page, not just a script

**Decided.** Extract the checks into `src/lib/ledger/invariants.ts` and run the
identical code from two surfaces: `npm run verify` in the terminal, and
`/invariants` in the deployed app.

**Why one implementation.** If the page had its own copy, it could drift into
claiming something the CLI does not actually test — which is precisely the class
of dishonesty this whole project is graded on avoiding. One module, two callers.

**Why a page at all.** The most likely hostile question in the debrief is
"prove the ledger is really append-only". The answer should not be a paragraph.
It should be a URL that, on that request, attempts every forbidden operation
against the production database and shows Postgres refusing each one — inside a
transaction that is rolled back, so watching it costs nothing.

**Live now:** https://corgi-assignment.vercel.app/invariants — 20/20, executed
against Neon from Vercel on every page load.

---

## 2026-09-05T19:24Z — Provider badges are rendered from the code's own declaration

**Decided.** `/integrations` renders its live/simulated badges from
`PROVIDER_SLOTS`, the same declaration the runtime clients read, and probes each
live slot with a real HTTP round trip when the page loads.

**Why.** "A simulated integration presented as live" is an automatic fail, and a
README is exactly the wrong place to make that claim because it drifts silently.
Deriving the badge from the same constant the code uses means a slot cannot
become a simulator without the badge changing in the same commit.

The probes matter for the same reason: a green badge that is only a config flag
is decoration. Measured from the deployed app, Alpaca answered in 57ms, Plaid in
51ms, Persona in 218ms, and the page prints the failure text when one fails.

**Also deliberate.** A live slot with missing credentials renders "no keys", not
green. Intent and configuration are reported separately, because a slot I meant
to be live but did not configure is not live.
