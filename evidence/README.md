# Evidence pack — live provider integrations

Screenshots of each provider's own dashboard, taken from the accounts this
system actually calls. The point of each one is not that a screen exists, but
that an id on it can be found in this repository's ledger, and vice versa.

Sandbox throughout. No live-mode keys, no real money, no real personal data.
Nothing here contains a credential: the images show request ids, account ids and
transaction ids, all of which are sandbox identifiers and none of which grant
access to anything.

## The files

| File | Provider | What it proves |
|---|---|---|
| `01-plaid-logs.png` | Plaid (sandbox) | The bank-link flow, in order: `/sandbox/public_token/create`, `/item/public_token/exchange`, `/identity/get`, `/processor/token/create` — all 200. The identity call is the one that matters: the account owner is checked against the customer on file *before* a processor token is minted, which is why funding from a stranger's account is refused rather than recorded. |
| `02-alpaca-broker.png` | Alpaca Broker API (sandbox) | 23 brokerage accounts opened, one per customer, in their own names. Recent funding transactions show real ACH deposits of USD 25,000 sitting at `SENT_TO_CLEARING` with transfer ids. Those ids appear on our `deposit.initiated` journal entries. |
| `03-alpaca-paper-orders.png` | Alpaca Trading API, paper account `PA36XI98LTKC` | Real notional orders resting at a broker — VOO, VTI, VXUS, BND, `accepted`, awaiting the open. Submitted by our `/api/invest` route. This is the execution venue; the Broker API above is the account and money side. |
| `04-persona-api-logs.png` | Persona (sandbox) | `POST /api/v1/inquiries` → 201, and `POST /api/v1/inquiries/{id}/decline` → 200. Identity decisions are made by Persona, not by us: those endpoints are Persona's own, and our KYC status changes only when the signed webhook arrives. |

## The webhook delivery log

**https://corgi-assignment.vercel.app/webhooks** — public, no sign-in.

Every inbound delivery from Persona, Plaid and the Alpaca bridge, with its
signature verdict, what was done with it, and how many times it arrived.

Also public:

**https://corgi-assignment.vercel.app/integrations** — every provider slot with
its mode, probed with a real HTTP round trip on each page load. A slot cannot
silently become a simulator without the badge changing, because the badge and
the behaviour read from the same declaration.

## Reproducing it rather than trusting it

```
npm run evidence
```

Calls each provider's API and prints what **they** say exists — deliberately
without reading our database.
