/**
 * GET /api/review/inbox
 * Powers the in-app Inbox. Returns two queues for the signed-in user:
 *   1. reviews  — open PRs where the user is a requested reviewer (admin sees all)
 *   2. feedback — comments the user RECEIVED on their own open PRs, so they can
 *                 go back and make the requested changes
 *
 * Returns: {
 *   reviews:  [{ number, title, author, createdAt, url, summary }],
 *   feedback: [{ number, title, url, comments: [{ author, body, createdAt, url }] }],
 *   isAdmin
 * }
 */
import { gh, getToken, getLogin, getConfig, json } from '../_gh.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return json({ error: 'not_authenticated' }, 401);

  const cfg = getConfig(env);

  // List open PRs on upstream
  const listRes = await gh(
    token, 'GET',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/pulls?state=open&per_page=100`
  );
  if (!listRes.ok) return json({ error: 'list_failed', detail: listRes.data }, 502);

  const prs = Array.isArray(listRes.data) ? listRes.data : [];

  // Keep only PRs where this user is a requested reviewer OR is the admin
  // (the admin sees everything so they can chase contributors).
  const isAdmin = login === cfg.adminLogin;
  const reviews = prs
    .filter((pr) => {
      if (isAdmin) return true;
      const reqd = (pr.requested_reviewers || []).map((r) => r.login);
      return reqd.includes(login);
    })
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user ? pr.user.login : '',
      createdAt: pr.created_at,
      url: pr.html_url,
      summary: (pr.body || '').split('\n')[0] || '',
    }));

  // Feedback received: comments other people left on the user's OWN open PRs.
  const myPrs = prs.filter((pr) => pr.user && pr.user.login === login);
  const feedback = [];
  for (const pr of myPrs) {
    const cRes = await gh(
      token, 'GET',
      `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/issues/${pr.number}/comments?per_page=100`
    );
    if (!cRes.ok || !Array.isArray(cRes.data)) continue;
    const comments = cRes.data
      // drop the automated "🔔 new edit ready for review" notifications; keep
      // every real human comment (including your own, so the thread is complete)
      .filter((c) => c.body && c.body.indexOf('🔔') !== 0)
      // drop bot comments (e.g. the Cloudflare Pages deploy bot) — reviewers
      // only care about human feedback, not CI/deploy chatter.
      .filter((c) => !(c.user && (c.user.type === 'Bot' || /\[bot\]$/i.test(c.user.login || ''))))
      .map((c) => ({
        author: c.user ? c.user.login : '',
        body: c.body || '',
        createdAt: c.created_at,
        url: c.html_url,
        mine: !!(c.user && c.user.login === login),
      }));
    if (comments.length) {
      feedback.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        comments,
      });
    }
  }

  return json({ reviews, feedback, count: reviews.length, isAdmin });
}
