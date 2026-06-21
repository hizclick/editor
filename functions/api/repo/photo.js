/**
 * GET /api/repo/photo?path=photos/whatever.jpg
 * Streams an image file from the signed-in user's working branch
 * (edit-{login}) so the editor can display photos that live in the GitHub
 * repo (they are not served from the app's own origin). Newly-added photos
 * that haven't been committed yet are shown from their in-memory data URL on
 * the client, so this proxy only needs to serve already-committed files.
 */
import { getToken, getLogin, getConfig, userBranch } from '../_gh.js';

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return new Response('unauthorized', { status: 401 });

  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  // only allow image paths inside the repo; block traversal
  if (!path || path.includes('..') || /^https?:/i.test(path)) {
    return new Response('bad path', { status: 400 });
  }

  const cfg = getConfig(env);
  const owner = cfg.upstreamOwner;
  const repo = cfg.upstreamRepo;
  const branch = userBranch(login);

  // The TEI references photos as "photos/x.jpg", but in some repos the files
  // actually live under a subfolder (e.g. "welde-mariam-digital-edition/
  // photos/x.jpg"). Try the path as-is first, then with the configured prefix.
  const candidates = [path];
  if (cfg.photoPrefix && !path.startsWith(cfg.photoPrefix + '/')) {
    candidates.push(cfg.photoPrefix.replace(/\/+$/, '') + '/' + path);
  }

  let ghRes = null;
  for (const candidate of candidates) {
    // Fetch the raw bytes (Accept: raw handles files of any size, unlike the
    // JSON contents API which truncates files over 1 MB).
    ghRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(candidate)}?ref=${encodeURIComponent(branch)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'welde-mariam-editor',
          Accept: 'application/vnd.github.raw',
        },
      }
    );
    if (ghRes.ok) break;
  }
  if (!ghRes || !ghRes.ok) return new Response('not found', { status: 404 });

  const ext = (path.split('.').pop() || '').toLowerCase();
  const headers = new Headers();
  headers.set('Content-Type', MIME[ext] || 'application/octet-stream');
  headers.set('Cache-Control', 'private, max-age=300');
  return new Response(ghRes.body, { status: 200, headers });
}
