/**
 * POST /api/auth/logout
 * Clears the session cookies (gh_token + gh_login) so the user is fully
 * signed out. Without this, a page refresh would re-read the still-valid
 * cookie and silently sign the user back in.
 */
export async function onRequestPost() {
  const headers = new Headers();
  headers.append('Content-Type', 'application/json');
  // expire both cookies immediately (Max-Age=0)
  headers.append('Set-Cookie', 'gh_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  headers.append('Set-Cookie', 'gh_login=; Secure; SameSite=Lax; Path=/; Max-Age=0');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
