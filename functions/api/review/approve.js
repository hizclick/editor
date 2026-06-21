/**
 * POST /api/review/approve
 * Approves the PR and merges it. If the PR cannot be merged automatically
 * (a conflict), we do NOT ask the reviewer to resolve it — instead we post a
 * comment that notifies @hizclick (the admin) to resolve, and tell the caller
 * it was escalated.
 *
 * Body: { number }
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
  if (!number) return json({ error: 'no_number' }, 400);

  // 1) Submit an approving review
  await gh(
    token, 'POST',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/pulls/${number}/reviews`,
    { event: 'APPROVE', body: `ጸድቋል · Approved by @${login}` }
  ).catch(() => {});

  // 2) Check mergeability first
  const prRes = await gh(token, 'GET', `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/pulls/${number}`);
  if (!prRes.ok) return json({ error: 'pr_failed', detail: prRes.data }, 502);
  const pr = prRes.data;
  const author = pr.user ? pr.user.login : '';

  // mergeable can be null briefly while GitHub computes it; treat null as "try"
  if (pr.mergeable === false) {
    // CONFLICT → escalate to admin, do not attempt a messy merge
    await notifyConflict(token, cfg, number, author, login);
    return json({ ok: false, conflict: true, escalatedTo: cfg.adminLogin });
  }

  // 3) Attempt the merge
  const mergeRes = await gh(
    token, 'PUT',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/pulls/${number}/merge`,
    { merge_method: 'squash', commit_title: `Merge edit from @${author} (approved by @${login})` }
  );

  if (mergeRes.ok) {
    // notify author + admin of the successful merge
    await gh(
      token, 'POST',
      `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/issues/${number}/comments`,
      { body: `✅ ${author ? '@' + author + ' ' : ''}ለውጥዎ ጸድቆ ተካቷል · your change was approved and merged. (cc @${cfg.adminLogin})` }
    ).catch(() => {});
    return json({ ok: true, merged: true });
  }

  // 4) Merge failed (often a conflict that surfaced at merge time) → escalate
  if (mergeRes.status === 405 || mergeRes.status === 409) {
    await notifyConflict(token, cfg, number, author, login);
    return json({ ok: false, conflict: true, escalatedTo: cfg.adminLogin });
  }

  return json({ error: 'merge_failed', detail: mergeRes.data }, 502);
}

async function notifyConflict(token, cfg, number, author, reviewer) {
  // Only @-mention the admin (hizclick) so the conflict notification goes to
  // them alone. The contributor and reviewer are shown WITHOUT an @ so they are
  // not pinged about a conflict they should not have to resolve.
  const contributor = author ? author : 'unknown';
  const msg = 
    `Please contact the admin. \n\n` +
    `አስተዋጽዖ · contributor: ${contributor} · reviewer: ${reviewer}`;
  await gh(
    token, 'POST',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/issues/${number}/comments`,
    { body: msg }
  ).catch(() => {});
}
