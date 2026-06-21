/**
 * GET /api/auth/callback?code=...&state=...
 * GitHub redirects here after the user approves. We:
 *   1. verify the state cookie (CSRF protection)
 *   2. exchange the code for an access token (using the SECRET, server-side)
 *   3. fetch the user's GitHub login
 *   4. store the token in an HttpOnly session cookie (never exposed to JS)
 *   5. redirect back to the app
 *
 * SECURITY: the access token lives ONLY in an HttpOnly cookie. Browser
 * JavaScript can never read it. All GitHub calls that need it go through our
 * /api/repo/* and /api/review/* functions, which read the cookie server-side.
 */
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const baseUrl = env.APP_BASE_URL || url.origin;

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // verify state against the cookie
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  if (!code || !state || state !== cookies.oauth_state) {
    return redirect(`${baseUrl}/?auth=error`, clearStateCookie());
  }

  // exchange the code for an access token (server-side, with the secret)
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${baseUrl}/api/auth/callback`,
    }),
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    return redirect(`${baseUrl}/?auth=error`, clearStateCookie());
  }

  // fetch the user login (so the UI can greet them)
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'welde-mariam-editor',
      Accept: 'application/vnd.github+json',
    },
  });
  const user = await userRes.json();

  // Store the token + login in HttpOnly session cookies. In production you may
  // prefer to store the token in a server-side KV keyed by a random session id;
  // here we keep it simple with a signed HttpOnly cookie.
  const headers = new Headers();
  headers.append('Location', `${baseUrl}/?auth=ok`);
  headers.append(
    'Set-Cookie',
    `gh_token=${accessToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`
  );
  // login is NOT secret (it's just the username), so the UI may read it
  headers.append(
    'Set-Cookie',
    `gh_login=${encodeURIComponent(user.login || '')}; Secure; SameSite=Lax; Path=/; Max-Age=28800`
  );
  // the person's real/display name (falls back to login) for friendly greeting
  headers.append(
    'Set-Cookie',
    `gh_name=${encodeURIComponent(user.name || user.login || '')}; Secure; SameSite=Lax; Path=/; Max-Age=28800`
  );
  headers.append('Set-Cookie', clearStateCookie());
  return new Response(null, { status: 302, headers });
}

function redirect(location, extraCookie) {
  const headers = new Headers();
  headers.append('Location', location);
  if (extraCookie) headers.append('Set-Cookie', extraCookie);
  return new Response(null, { status: 302, headers });
}
function clearStateCookie() {
  return 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
function parseCookies(str) {
  const out = {};
  str.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
