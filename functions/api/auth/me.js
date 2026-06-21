/**
 * GET  /api/auth/me      → { loggedIn, login } (reads cookies, never returns the token)
 * POST /api/auth/logout  → clears the session cookies
 */
export async function onRequestGet(context) {
  const cookies = parseCookies(context.request.headers.get('Cookie') || '');
  const token = cookies.gh_token || '';
  const loggedIn = !!token;
  if (!loggedIn) return json({ loggedIn: false, login: null, name: null });

  // Prefer the cached name cookie; otherwise ask GitHub for the real/display
  // name (so existing sessions without the cookie still get a friendly name).
  let login = cookies.gh_login || null;
  let name = cookies.gh_name || null;
  if (!name) {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'welde-mariam-editor',
          Accept: 'application/vnd.github+json',
        },
      });
      if (res.ok) {
        const u = await res.json();
        login = u.login || login;
        name = u.name || u.login || login;
      }
    } catch (_e) { /* fall back to login below */ }
  }
  return json({ loggedIn, login, name: name || login });
}

export async function onRequestPost(context) {
  // logout: clear cookies
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', 'gh_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  headers.append('Set-Cookie', 'gh_login=; Secure; SameSite=Lax; Path=/; Max-Age=0');
  headers.append('Set-Cookie', 'gh_name=; Secure; SameSite=Lax; Path=/; Max-Age=0');
  return new Response(JSON.stringify({ loggedIn: false }), { headers });
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' },
  });
}
function parseCookies(str) {
  const out = {};
  str.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
