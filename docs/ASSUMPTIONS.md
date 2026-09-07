# Assumptions

Every one of these is a decision I made without being told, and any of them
could be wrong. They are written down so a reviewer can disagree with the
*assumption* rather than reverse-engineer it from the code — and so that if one
turns out to be wrong, the cost of changing it is legible in advance.

Each is stated the same way: **what · why it holds · what breaks if it doesn't ·
how you would find out.** The last column is the one that matters. An assumption
with no detection story is a belief.

[`DECISIONS.md`](DECISIONS.md) records choices as they were made;
[`DESIGN.md`](DESIGN.md) is the settled architecture. This is the ground both
stand on.

---

## 1. Accounting

### TWR is the headline return, not money-weighted

**Why.** The customer doesn't control the market and the manager doesn't control
the customer's savings habits. Judging a manager on a figure that moves when the
customer happens to deposit is judging them on someone else's timing.

**If wrong.** For a customer who wants "what did *my* money actually earn", MWR
is the better answer, and TWR can look wrong to them in a way that is hard to
explain.

**How you'd find out.** Support tickets asking why the percentage doesn't match
"I put in £X and now have £Y". The flow data needed for MWR is already all in
the ledger — it is a second read over the same rows, not a migration.

### FIFO for lot selection, absent specific identification

**Why.** The IRS default, and the only sane choice when a rebalance generates
sells the customer never individually authorised. Picking HIFO on the customer's
behalf is making a tax election for them.

**If wrong.** Customers in a taxable account may be leaving money on the table
versus HIFO or specific-ID.

**How you'd find out.** Lot ordering is a *comparator*, not a hardcoded rule —
`fifoOrder` is a parameter to `planDisposal`, and a test proves HIFO is a
comparator swap. Changing the policy is a one-line change, not a rewrite.

### Commissions capitalise into cost basis

**Why.** Correct US treatment. A commission expensed separately produces a wrong
1099-B.

**If wrong.** It isn't, for US equities. In a jurisdiction that treats
transaction costs differently, the basis figures are wrong and so is every
realised gain derived from them.

**How you'd find out.** A tax accountant reviewing a generated 1099-B. This is
the assumption I would most want a domain expert to confirm before real money.

### T+1 settlement, and unsettled proceeds are investable but not withdrawable

**Why.** US cash-account rules permit buying with unsettled proceeds; taking them
out of the door before they settle is free-riding.

**If wrong.** If the real custodian settles differently, the three cash buckets
mis-state what a customer can actually do, and a withdrawal could be approved
against money that isn't there.

**How you'd find out.** Reconciliation. Our settled-cash figure would diverge
from the custodian's, and that is precisely a `genuine.cash` break rather than a
silent error.

### Unrealised gain is not a ledger entry

**Why.** A price moving is not a transaction. Nothing happened, nobody owes
anyone anything, and writing an entry for it would put an opinion in the journal.
Realised gain *is* an entry, and falls out of the balance requirement on a sell.

**If wrong.** Some reporting regimes want unrealised P&L accrued into the books
rather than computed at read time.

**How you'd find out.** An accounting standard that requires it. The valuation
tables already hold everything needed to produce the figure without journalising
it.

### Half away from zero, at one chokepoint

**Why.** Customers check arithmetic by hand and expect 0.5 to go up. Banker's
rounding is better for large aggregates and worse for explaining a single
statement line.

**If wrong.** Systematic upward bias across very large volumes.

**How you'd find out.** It is set once at module load in `money.ts` so no file
can change it underneath, and the residual is measurable: the house absorbs any
unattributable penny into `expenses:rounding`, so the bias has a balance you can
read.

### The house eats the residual penny, never the customer

**Why.** Largest-remainder allocation guarantees the parts sum to exactly the
whole, but someone must absorb the odd cent. A firm can afford it; a customer
noticing a missing penny loses trust in every other number.

**If wrong.** At sufficient scale the residual is a real cost line.

**How you'd find out.** `expenses:rounding` has a balance. Watch it.

---

## 2. Scope

### USD only

Explicitly out of scope in the brief. The ledger is **already multi-commodity**,
so USD/EUR is the same machinery as USD/VOO — what is missing is FX rates as a
priced fact and a reporting-currency choice, not a schema change.

### Discretionary model portfolios, not self-directed trading

**Why.** The brief describes buying into a model. Self-directed order entry is a
different product with different suitability obligations.

**If wrong.** A customer who wants to buy a single stock cannot.

**How you'd find out.** `/api/invest` takes a model id. The order path underneath
is per-symbol notional orders, so single-symbol entry is a route away, not an
architecture away.

### One active funding bank per customer at a time

**Why.** Alpaca permits exactly one active ACH relationship per account, so this
is the broker's constraint surfaced rather than a product choice. Modelling two
would be modelling something the rail cannot do.

**If wrong.** A customer with two banks must unlink and relink.

**How you'd find out.** `bank_links` keeps every attempt including deactivated
and refused ones, so the history is already multi-row — only the *active*
constraint is single.

### $1,000 is the money-out approval threshold

**Why.** Any threshold is arbitrary; what matters is that it is enforced in one
place and cannot drift. `APPROVAL_THRESHOLD_CENTS = 1_000_00n`.

**If wrong.** A real firm sets this by risk appetite and it is almost certainly
not $1,000.

**How you'd find out.** It is one constant, and the invariant suite probes the
CHECK constraint at its exact boundary **from the TypeScript constant**, so the
number and the enforcement cannot disagree. Changing it is one edit.

### Web app, responsive rather than native

The brief makes portal choice a scoping call. In 48 hours a web app that works
on a phone beats a second codebase.

---

## 3. Time

### Market dates are New York calendar days; the calendar is NYSE

**Why.** US equities. A "trading day" is meaningless without a venue.

**If wrong.** Every date boundary in valuation, performance and reconciliation
shifts.

**How you'd find out.** This one already bit: comparing a `timestamptz` against
UTC midnight hid everything booked between 20:00 and 23:59 New York — a
four-hour blind spot, every evening. It is now one helper defined once
(`MARKET_DAY_END_SQL`) rather than nine open-coded comparisons.

### All timestamps in the decision log are EDT

Correct for every date in this project. A system with a longer history would
resolve the offset per date rather than assuming one.

### Sandbox ACH settles on trading days, not on a timer

**Why.** Observed, not assumed — Alpaca's sandbox genuinely holds a transfer at
`SENT_TO_CLEARING` over a weekend.

**If wrong.** Nothing; we model the in-flight state as a first-class ledger
position either way, so a faster rail simply moves the second entry closer to the
first.

---

## 4. Integrations

### Sandbox behaviour represents production for the flows exercised

**Why.** It is what a trial can access, and it is the load-bearing assumption of
the whole integration layer.

**If wrong.** This is the assumption most likely to be wrong, and I would flag it
first before real money. Sandboxes differ from production in ways that are
invisible until they aren't — rate limits, settlement timing, error taxonomies,
identity-check strictness.

**How you'd find out.** Where a sandbox limit was discovered rather than assumed,
it is recorded as such: outgoing ACH returns `403` on **direction**, established
by testing an unknown relationship id and getting the identical refusal, not by
inferring from a balance.

### Persona owns identity decisions; we never decide KYC ourselves

**Why.** An identity decision carries regulatory weight. A system that can set
its own KYC status has removed the control.

**If wrong.** It is not — but it does mean our status can lag Persona's, and a
provider event can arrive late, duplicated, or about a superseded inquiry.

**How you'd find out.** All three happened. Status is ordered by **Persona's**
event time, not ours; events for a superseded inquiry are recorded but not acted
on; an expiry is treated as abandonment rather than a decision.

### On the omnibus venue, our ledger is the record of who owns what

**Why.** The paper account is one account shared by every customer routed to it —
the broker genuinely cannot tell them apart.

**If wrong.** Nothing else can tell them apart either, which is the point.

**How you'd find out.** This *sharpens* the case for reconciliation rather than
weakening it. Every order records its venue and the API says `omnibus: true`, so
the arrangement is stated rather than hidden.

### Provider webhooks may arrive late, duplicated, or out of order

Not an assumption so much as a design premise, and all three were observed.
Signature verified before the idempotency key is claimed; duplicates recorded
rather than dropped; ordering by the provider's clock.

### Market data is simulated, and that is declared

Alpaca Broker sandbox keys are not entitled to the market data API — 401 on every
auth form. The brief permits this slot to be simulated. Owning the price source
is also what makes a corrected close on demand possible, which is the entire
restatement demonstration.

---

## 5. Operating

### Sandbox credentials and documented test identities only. No real PII, ever

Not an assumption — a hard rule. No live-mode keys, no real money, no real
personal data, no secrets in the repository.

### Single region, single Postgres, isolation by `customer_id`

**Why.** Appropriate for the scale this is built at.

**If wrong.** A multi-tenant deployment needs row-level security rather than
application-level scoping, and residency rules may forbid a single region.

**How you'd find out.** The reads are already parameterised by `customer_id`
everywhere; RLS would be additive rather than a rewrite. `DESIGN.md` §10 covers
what changes at scale.

---

## What I would want confirmed before real money

In order:

1. **Sandbox-to-production fidelity** — the load-bearing one, and the one no
   amount of care inside this repository can settle.
2. **Cost-basis and 1099-B treatment**, by someone who does this for a living.
3. **The settlement model** against the actual custodian's actual rules, not the
   general US ones.

Everything else on this page I would defend as written.
