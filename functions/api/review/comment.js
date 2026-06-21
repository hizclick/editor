/**
 * POST /api/review/comment
 * Posts a comment on the PR. The comment @-mentions the PR author so they get an
 * in-GitHub notification (which the app surfaces as their in-app inbox), and the
 * admin is notified too.
 *
 * Body: { number, comment }
 */
import { gh, getToken, getLogin, getConfig, json } from '../_gh.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return json({ error: 'not_authenticated' }, 401);

  const cfg = getConfig(env);
  const body = await request.json().catch(() => ({}));
  const number = body.number;
  const comment = (body.comment || '').trim();
  if (!number || !comment) return json({ error: 'bad_request' }, 400);

  // find the author to @-mention them
  const prRes = await gh(token, 'GET', `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/pulls/${number}`);
  const author = prRes.ok && prRes.data.user ? prRes.data.user.login : '';

  const text =
    (author ? `@${author} ` : '') +
    comment +
    `\n\n— ግምገማ · review comment from @${login}` +
    (login !== cfg.adminLogin ? `  (cc @${cfg.adminLogin})` : '');

  const res = await gh(
    token, 'POST',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/issues/${number}/comments`,
    { body: text }
  );
  if (!res.ok) return json({ error: 'comment_failed', detail: res.data }, 502);
  return json({ ok: true, url: res.data.html_url });
}
