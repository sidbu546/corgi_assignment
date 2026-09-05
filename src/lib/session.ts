/**
 * session.ts — who is asking, on the server.
 *
 * Server-only. Every page and route that shows or moves money calls
 * `requireCustomer` or `requireOps` rather than trusting anything from the
 * client. A role carried in a request body or a query string is a suggestion,
 * not an identity.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, decodeSession, type SessionPayload } from './auth';

export async function currentUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<SessionPayload> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * A customer session, with the customer id guaranteed present.
 *
 * Ops users are redirected rather than shown someone's portfolio: an ops user
 * viewing customer data should do it through the ops console, where it is
 * attributable, not by wandering into the customer app.
 */
export async function requireCustomer(): Promise<
  SessionPayload & { customerId: string }
> {
  const user = await requireUser();
  if (user.role !== 'customer' || !user.customerId) redirect('/ops');
  return user as SessionPayload & { customerId: string };
}

export async function requireOps(): Promise<SessionPayload> {
  const user = await requireUser();
  if (user.role !== 'ops') redirect('/portfolio');
  return user;
}
