/**
 * GET /api/auth/login
 * Starts the GitHub OAuth flow. Redirects the user to GitHub's authorize page.
 *
 * The CLIENT SECRET never appears here — only the public CLIENT ID. The secret
 * is used later (in callback.js) on the server side to exchange the code.
 *
 * Required Cloudflare environment variables (Settings → Environment variables):
 *   GITHUB_CLIENT_ID      — your GitHub App / OAuth App client id (public)
 *   GITHUB_CLIENT_SECRET  — the client secret (KEEP SECRET; used in callback.js)
 *   APP_BASE_URL          — e.g. https://your-edition.pages.dev (no trailing slash)
 */
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const clientId = env.GITHUB_CLIENT_ID;
  const baseUrl = env.APP_BASE_URL || url.origin;

  // A random state value protects against CSRF. We store it in a short-lived,
  // HttpOnly cookie and verify it in the callback.
  const state = crypto.randomUUID();

  // "scope" requests the permissions we need: repo (read/write contents + PRs).
  const scope = 'repo read:user';
  const redirectUri = `${baseUrl}/api/auth/callback`;

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', scope);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'true'); // lets new users create an account

  const headers = new Headers();
  headers.append('Location', authorize.toString());
  // store state in an HttpOnly cookie for 10 minutes
  headers.append(
    'Set-Cookie',
    `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );
  return new Response(null, { status: 302, headers });
}
