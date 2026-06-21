/**
 * Shared helpers for the GitHub-backed functions.
 * Config comes from Cloudflare environment variables:
 *   UPSTREAM_OWNER   — the family edition repo owner (e.g. "hizclick")
 *   UPSTREAM_REPO    — the repo name (e.g. "welde-mariam-edition")
 *   UPSTREAM_BRANCH  — base branch (e.g. "main")
 *   TEI_PATH         — path to the TEI file in the repo (e.g. "welde-mariam-family-history-tei.xml")
 *   REVIEWERS        — comma-separated default reviewers (e.g. "hizclick")
 *   ADMIN_LOGIN      — who gets notified on PRs/comments/conflicts (e.g. "hizclick")
 */

export function getConfig(env) {
  return {
    upstreamOwner: env.UPSTREAM_OWNER || 'hizclick',
    upstreamRepo: env.UPSTREAM_REPO || 'welde-mariam-digital-edition',
    upstreamBranch: env.UPSTREAM_BRANCH || 'main',
    teiPath: env.TEI_PATH || 'welde-mariam-family-history-tei.xml',
    // Some repos nest the photos under a subfolder (e.g. the photos referenced
    // in the TEI as "photos/x.jpg" actually live at
    // "welde-mariam-digital-edition/photos/x.jpg"). The photo proxy tries the
    // path as-is first, then prefixed with this value.
    photoPrefix: env.PHOTO_PREFIX || 'welde-mariam-digital-edition',
    reviewers: (env.REVIEWERS || 'hizclick').split(',').map((s) => s.trim()).filter(Boolean),
    adminLogin: env.ADMIN_LOGIN || 'hizclick',
  };
}

/* the per-user working branch name */
export function userBranch(login) {
  return 'edit-' + String(login).replace(/[^A-Za-z0-9._-]/g, '-');
}

export function getToken(request) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  return cookies.gh_token || null;
}
export function getLogin(request) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  return cookies.gh_login || null;
}

export async function gh(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'welde-mariam-editor',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* Pull a human-readable message out of a gh() result for surfacing to the UI. */
export function githubMessage(res) {
  if (!res) return '';
  const d = res.data;
  if (d && typeof d.message === 'string') return d.message;
  if (d && typeof d.raw === 'string') return d.raw;
  return '';
}

/* Resolve the base branch ref, falling back to the repo's real default branch
   (handles repos whose default is "master" or anything other than UPSTREAM_BRANCH).
   Returns { ok, ref, branch, error, message, status }. */
export async function resolveBaseRef(token, owner, repo, preferredBranch) {
  let branch = preferredBranch;
  let ref = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (ref.ok) return { ok: true, ref: ref.data, branch };

  // Preferred branch missing — ask the repo for its actual default branch.
  const repoInfo = await gh(token, 'GET', `/repos/${owner}/${repo}`);
  if (!repoInfo.ok) {
    return {
      ok: false,
      status: repoInfo.status,
      error: 'repo_unavailable',
      message:
        githubMessage(repoInfo) ||
        `Cannot access ${owner}/${repo}. Make sure the repository exists and you are a collaborator.`,
    };
  }
  branch = repoInfo.data.default_branch;
  ref = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (ref.ok) return { ok: true, ref: ref.data, branch };

  return {
    ok: false,
    status: ref.status,
    error: 'no_base_branch',
    message:
      `The repository ${owner}/${repo} has no "${branch}" branch yet. ` +
      `Add an initial commit/file on GitHub first.`,
  };
}

export function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/* base64 encode/decode that is UTF-8 safe (TEI is full of Amharic) */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
