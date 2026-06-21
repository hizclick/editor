/**
 * GET /api/review/files?number=PR_NUMBER
 * Returns BEFORE (base/main) and AFTER (PR head branch) versions of the TEI so
 * the front-end can run the Stage-2 plain-Amharic diff. Shared-repo model: the
 * head branch lives in the SAME repo (no fork).
 *
 * Returns: { base, head, author, title, number }
 */
import { gh, getToken, getLogin, getConfig, json, base64ToUtf8 } from '../_gh.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return json({ error: 'not_authenticated' }, 401);

  const cfg = getConfig(env);
  const url = new URL(request.url);
  const number = url.searchParams.get('number');
  if (!number) return json({ error: 'no_number' }, 400);

  const prRes = await gh(token, 'GET', `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/pulls/${number}`);
  if (!prRes.ok) return json({ error: 'pr_failed', detail: prRes.data }, 502);
  const pr = prRes.data;

  const headRef = pr.head.ref;   // the user's branch, same repo
  const baseRef = pr.base.ref;   // main

  const baseRes = await gh(
    token, 'GET',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/contents/${encodeURIComponent(cfg.teiPath)}?ref=${baseRef}`
  );
  const headRes = await gh(
    token, 'GET',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/contents/${encodeURIComponent(cfg.teiPath)}?ref=${headRef}`
  );
  if (!baseRes.ok || !headRes.ok) {
    return json({ error: 'file_failed', base: baseRes.status, head: headRes.status }, 502);
  }

  return json({
    base: base64ToUtf8(baseRes.data.content || ''),
    head: base64ToUtf8(headRes.data.content || ''),
    author: pr.user ? pr.user.login : '',
    title: pr.title,
    number: pr.number,
  });
}
