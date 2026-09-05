import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * GET /logout — clear the session.
 *
 * A GET rather than a POST, which is normally the wrong choice: a GET logout can
 * be triggered by any image tag on any site. Accepted here because the entire
 * consequence is that a demo reviewer has to sign in again, and a form-post
 * logout in the header would be more machinery than that risk deserves. Noted
 * rather than glossed over — in a real product this is a POST with a CSRF token.
 */
export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0, httpOnly: true });
  return response;
}
