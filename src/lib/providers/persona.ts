/**
 * persona.ts — identity verification. LIVE against the Persona sandbox.
 *
 * The gate this feeds is the one the brief is blunt about: nobody funds an
 * account before passing, and pending and rejected must be visible, not just
 * approved.
 *
 * Two design points worth stating:
 *
 *  REFERENCE-ID IS OUR CUSTOMER ID. Persona echoes it back on every webhook,
 *  which is how an inbound event is attributed to a customer. Without it we
 *  would be matching on email, and an email is a mutable, user-controlled
 *  field — a poor primary key for "whose identity was verified".
 *
 *  WE NEVER SEND REAL PII. Sandbox inquiries carry Persona's own test
 *  identities. That is a rule of this trial and independently the right thing
 *  to do.
 */

import { assertSlotAvailable, ProviderUnavailableError } from './registry';

const SLOT = 'kyc';
const BASE = 'https://api.withpersona.com/api/v1';
const API_VERSION = '2023-01-05';

export class PersonaError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Persona ${status}: ${body.slice(0, 300)}`);
    this.name = 'PersonaError';
  }
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  assertSlotAvailable(SLOT);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
        'Persona-Version': API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw new PersonaError(response.status, text);
    return (text ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (error instanceof PersonaError) throw error;
    throw new ProviderUnavailableError(
      SLOT,
      'upstream',
      `Persona ${method} ${path} failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface Inquiry {
  id: string;
  status: string;
  referenceId: string | null;
}

interface InquiryResponse {
  data: {
    id: string;
    attributes: { status?: string; 'reference-id'?: string | null };
  };
}

/**
 * Open an inquiry for a customer.
 *
 * `reference-id` is deliberately our customer's UUID: it is the only thing that
 * lets a webhook arriving minutes later be attributed to the right person.
 */
export async function createInquiry(input: {
  customerId: string;
  templateId?: string;
}): Promise<Inquiry> {
  const result = await call<InquiryResponse>('POST', '/inquiries', {
    data: {
      attributes: {
        'inquiry-template-id': input.templateId ?? process.env.PERSONA_TEMPLATE_ID,
        'reference-id': input.customerId,
      },
    },
  });

  return {
    id: result.data.id,
    status: result.data.attributes.status ?? 'created',
    referenceId: result.data.attributes['reference-id'] ?? null,
  };
}

export async function getInquiry(inquiryId: string): Promise<Inquiry> {
  const result = await call<InquiryResponse>('GET', `/inquiries/${inquiryId}`);
  return {
    id: result.data.id,
    status: result.data.attributes.status ?? 'unknown',
    referenceId: result.data.attributes['reference-id'] ?? null,
  };
}

/**
 * The hosted flow the customer is sent to.
 *
 * Persona's Link-style URL. Building it here rather than in the UI keeps the
 * template id server-side, where it belongs.
 */
export function hostedFlowUrl(inquiryId: string): string {
  return `https://withpersona.com/verify?inquiry-id=${encodeURIComponent(inquiryId)}`;
}

// -----------------------------------------------------------------------------
// Sandbox transitions
//
// Persona's OWN sandbox endpoints, not simulators of ours: they drive a real
// inquiry through a real state change, and Persona emits the real webhook. They
// exist so that pending, approved and DECLINED are all reachable on demand —
// the brief asks for the unhappy states to be demonstrable, and waiting for a
// human to fail a document upload is not a demo.
// -----------------------------------------------------------------------------

export async function sandboxTransition(
  inquiryId: string,
  action: 'approve' | 'decline',
): Promise<Inquiry> {
  const result = await call<InquiryResponse>('POST', `/inquiries/${inquiryId}/${action}`);
  return {
    id: result.data.id,
    status: result.data.attributes.status ?? 'unknown',
    referenceId: result.data.attributes['reference-id'] ?? null,
  };
}

export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    await call('GET', '/inquiries?page%5Bsize%5D=1');
    return { ok: true, detail: 'inquiries endpoint reachable' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
