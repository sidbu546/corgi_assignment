/**
 * registry.ts — honest labelling of what is real and what is not.
 *
 * "A simulated integration presented as live" is an automatic fail on this
 * project, and rightly so. So rather than leaving that claim to a README that
 * can drift from the code, every provider slot is declared here once, with its
 * mode, and the UI reads THIS to render its badges.
 *
 * Consequence: a slot cannot silently become a simulator without the badge on
 * the screen changing at the same moment. The label and the behaviour come from
 * one source.
 *
 * `health` is what makes graceful degradation demonstrable: when a provider is
 * down — or deliberately killed from the ops console, which is a thing you can
 * do here — the UI keeps working and says plainly which data is stale and why.
 */

export type ProviderMode = 'live' | 'simulated';

export interface ProviderSlot {
  id: string;
  /** The domain job this slot does, in the brief's own vocabulary. */
  slot: string;
  provider: string;
  mode: ProviderMode;
  /** Where the real calls go. Shown in the UI so 'live' is checkable. */
  endpoint?: string;
  /** Why simulated, if it is. Honest, not defensive. */
  note: string;
  /** Env vars that must be present for a live slot to actually function. */
  requiredEnv: string[];
}

export const PROVIDER_SLOTS: ProviderSlot[] = [
  {
    id: 'brokerage',
    slot: 'Brokerage and custody',
    provider: 'Alpaca Broker API (sandbox)',
    mode: 'live',
    endpoint: 'https://broker-api.sandbox.alpaca.markets',
    note:
      'A brokerage account PER CUSTOMER, in their own name — the correct model ' +
      'for a retail investing product. Real accounts, real ACH relationships, ' +
      'real orders. Fills and transfer transitions arrive over Alpaca SSE and ' +
      'are bridged into our webhook pipeline (Alpaca offers no webhook ' +
      'registration; verified, every such endpoint 404s).',
    requiredEnv: ['ALPACA_BROKER_KEY_ID', 'ALPACA_BROKER_SECRET'],
  },
  {
    id: 'brokerage_paper',
    slot: 'Brokerage — execution venue (paper)',
    provider: 'Alpaca Trading API, paper account',
    mode: 'live',
    endpoint: 'https://paper-api.alpaca.markets',
    note:
      'A second REAL Alpaca sandbox, pre-funded with $100,000, used so orders ' +
      'can reach a broker while Broker API ACH is still settling. Verified ' +
      'paper-only: the key is prefixed PK and the same key returns 401 against ' +
      'the live endpoint. ' +
      'It is ONE account shared by every customer routed to it — an OMNIBUS ' +
      'arrangement, labelled as such on every order. The broker cannot tell our ' +
      'customers apart, so our ledger is the only per-customer record, which is ' +
      'precisely why reconciliation matters more here rather than less.',
    requiredEnv: ['ALPACA_PAPER_KEY_ID', 'ALPACA_PAPER_SECRET'],
  },
  {
    id: 'kyc',
    slot: 'Identity verification',
    provider: 'Persona (sandbox)',
    mode: 'live',
    endpoint: 'https://api.withpersona.com',
    note:
      'Real hosted inquiry flow. Approved, pending and declined are all ' +
      'reachable using Persona test identities. No real PII is ever submitted.',
    requiredEnv: ['PERSONA_API_KEY', 'PERSONA_TEMPLATE_ID'],
  },
  {
    id: 'funding',
    slot: 'Bank linking and funding',
    provider: 'Plaid (sandbox)',
    mode: 'live',
    endpoint: 'https://sandbox.plaid.com',
    note:
      'Real Link flow against Plaid sandbox institutions, real auth and identity ' +
      'products. Deposits are initiated against the linked account.',
    requiredEnv: ['PLAID_CLIENT_ID', 'PLAID_SECRET'],
  },
  {
    id: 'market_data',
    slot: 'Market data (daily closes)',
    provider: 'Built in-house — SIMULATED',
    mode: 'simulated',
    note:
      'Downgraded from live after testing: Alpaca Broker sandbox credentials are ' +
      'not entitled to the market data API (401 on every auth form, both Basic ' +
      'and APCA headers). The brief lists this slot as "live or simulated", ' +
      'unlike brokerage, KYC and funding which must be live. ' +
      'The simulator generates a deterministic daily close series with real ' +
      'market-calendar gaps, and — the reason this is arguably the better choice ' +
      'here — it can issue a CORRECTED CLOSE on demand, which is what the ' +
      'restatement test requires and what no real feed will do for you.',
    requiredEnv: [],
  },
  {
    id: 'custodian_file',
    slot: 'Custodian file',
    provider: 'Built in-house — SIMULATED',
    mode: 'simulated',
    note:
      'A simulator, and the brief expects one. It ships a morning ' +
      'positions/cash/transactions file and deliberately generates the awkward ' +
      'cases: the late dividend, the corrected close, and a tampered position. ' +
      'This is where reconciliation earns its keep, so a simulator that only ' +
      'ever agrees with us would be worthless.',
    requiredEnv: ['CUSTODIAN_SIM_SECRET'],
  },
  {
    id: 'ach_settlement_notice',
    slot: 'ACH settlement notification',
    provider: 'Built in-house — SIMULATED',
    mode: 'simulated',
    note:
      'The deposit itself is LIVE: a Plaid-verified ACH relationship, a real ' +
      'Alpaca transfer and a real transfer id, held by Alpaca at ' +
      'SENT_TO_CLEARING. Simulated here is ONLY Alpaca telling us it COMPLETED ' +
      '— a notification the sandbox sends on its own, but only on a trading ' +
      'day, so at a weekend the whole downstream path is unreachable. ' +
      'Entries created this way say so in the ledger: kind is ' +
      'deposit.settled.simulated, source is simulator:rail, and the narrative ' +
      'states it. The ledger never claims Alpaca reported something it did not.',
    requiredEnv: [],
  },
  {
    id: 'ach_returns',
    slot: 'ACH returns',
    provider: 'Built in-house — SIMULATED',
    mode: 'simulated',
    note:
      'Plaid sandbox originates the deposit, but does not return it days later ' +
      'with an R01. The simulator produces the bounce, because "what does the ' +
      'customer see when a deposit fails after the cash was invested" is a ' +
      'question the real sandbox will not ask for us.',
    requiredEnv: [],
  },
];

export function slot(id: string): ProviderSlot {
  const found = PROVIDER_SLOTS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown provider slot: ${id}`);
  return found;
}

/**
 * A live slot whose credentials are missing is NOT live, whatever the table
 * says. Reporting configured-ness separately from intent is the difference
 * between an honest badge and a decorative one.
 */
export function slotIsConfigured(s: ProviderSlot): boolean {
  return s.requiredEnv.every((key) => Boolean(process.env[key]));
}

export interface SlotStatus extends ProviderSlot {
  configured: boolean;
  /** Set by the ops console kill switch to demo graceful degradation. */
  disabled: boolean;
}

/**
 * Deliberate outage switch.
 *
 * The debrief includes pulling a provider out from under us. Rather than hope
 * that goes well, the ops console can disable any slot on purpose, and the app
 * is expected to keep serving: cached valuations with a visible staleness
 * badge, orders queued rather than lost, and an explicit banner naming the slot
 * that is down. Handing over the switch is more convincing than surviving by
 * luck.
 */
const disabledSlots = new Set<string>();

export function disableSlot(id: string): void {
  slot(id);
  disabledSlots.add(id);
}

export function enableSlot(id: string): void {
  disabledSlots.delete(id);
}

export function slotDisabled(id: string): boolean {
  return disabledSlots.has(id);
}

export function slotStatuses(): SlotStatus[] {
  return PROVIDER_SLOTS.map((s) => ({
    ...s,
    configured: slotIsConfigured(s),
    disabled: disabledSlots.has(s.id),
  }));
}

/** Thrown when a slot is unavailable, so callers degrade instead of crashing. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly slotId: string,
    readonly reason: 'disabled' | 'unconfigured' | 'upstream',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export function assertSlotAvailable(id: string): void {
  const s = slot(id);
  if (disabledSlots.has(id)) {
    throw new ProviderUnavailableError(
      id,
      'disabled',
      `${s.provider} is disabled from the ops console (deliberate outage test)`,
    );
  }
  if (!slotIsConfigured(s)) {
    throw new ProviderUnavailableError(
      id,
      'unconfigured',
      `${s.provider} is missing credentials: ${s.requiredEnv.join(', ')}`,
    );
  }
}
