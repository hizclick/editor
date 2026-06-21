/**
 * POST /api/repo/save
 * Shared-repo model (no forks). Commits the edited TEI (and any new photos) to
 * the signed-in user's branch (edit-{login}) inside the same repo, then opens a
 * Pull Request from that branch -> main, requesting the chosen reviewer(s).
 *
 * Body: {
 *   content:  string  (edited TEI xml),
 *   message:  string  (optional commit message),
 *   photos:   [{ name, dataUrl }]  (optional new images),
 *   summary:  string  (optional PR body summary),
 *   reviewers: [string]  (chosen reviewer logins from the dropdown)
 * }
 */
import {
  gh, getToken, getLogin, getConfig, userBranch, json, utf8ToBase64,
  githubMessage, resolveBaseRef,
} from '../_gh.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return json({ error: 'not_authenticated' }, 401);

  const cfg = getConfig(env);
  const owner = cfg.upstreamOwner;
  const repo = cfg.upstreamRepo;
  const branch = userBranch(login);

  const body = await request.json().catch(() => ({}));
  const content = body.content;
  if (!content) return json({ error: 'no_content' }, 400);

  // chosen reviewers from the dropdown (fall back to the configured default)
  let reviewers = Array.isArray(body.reviewers) && body.reviewers.length
    ? body.reviewers : cfg.reviewers;
  // never request review from yourself (GitHub rejects it)
  reviewers = reviewers.filter((r) => r && r !== login);

  // 1) Ensure the user's branch exists (create from the base branch if missing)
  let branchRef = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (!branchRef.ok) {
    const base = await resolveBaseRef(token, owner, repo, cfg.upstreamBranch);
    if (!base.ok) return json({ error: base.error, message: base.message, status: base.status }, base.status === 404 ? 404 : 502);
    const created = await gh(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`, sha: base.ref.object.sha,
    });
    if (!created.ok && created.status !== 422) {
      return json({ error: 'branch_create_failed', message: githubMessage(created), detail: created.data }, 502);
    }
  }

  // 2) Commit the edited TEI to the user's branch
  const fileMeta = await gh(
    token, 'GET',
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(cfg.teiPath)}?ref=${branch}`
  );
  const teiSha = fileMeta.ok ? fileMeta.data.sha : undefined;
  const putTei = await gh(
    token, 'PUT',
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(cfg.teiPath)}`,
    {
      message: body.message || `Edit by ${login}`,
      content: utf8ToBase64(content),
      sha: teiSha,
      branch,
    }
  );
  if (!putTei.ok) return json({ error: 'commit_failed', detail: putTei.data }, 502);

  // 3) Commit any new photos into photos/ on the same branch
  const photos = Array.isArray(body.photos) ? body.photos : [];
  for (const ph of photos) {
    if (!ph || !ph.name || !ph.dataUrl) continue;
    const b64 = String(ph.dataUrl).split(',').pop();
    const safeName = ph.name.replace(/[^A-Za-z0-9._-]/g, '_');
    const photoPath = `photos/${safeName}`;
    const exist = await gh(
      token, 'GET',
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(photoPath)}?ref=${branch}`
    );
    await gh(
      token, 'PUT',
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(photoPath)}`,
      {
        message: `Add photo ${safeName} (by ${login})`,
        content: b64,
        sha: exist.ok ? exist.data.sha : undefined,
        branch,
      }
    );
  }

  // 4) Is there already an open PR for this branch? If so, reuse it (the commit
  //    above already updated it). Otherwise open a new PR branch -> main.
  let pr = null;
  const existing = await gh(
    token, 'GET',
    `/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branch}`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length) {
    pr = existing.data[0];
  } else {
    const prRes = await gh(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
      title: `Edit by ${login} — ${new Date().toISOString().slice(0, 10)}`,
      head: branch,
      base: cfg.upstreamBranch,
      body: (body.summary ? body.summary + '\n\n' : '') +
            `Submitted by @${login} via the family editor.\n\ncc @${cfg.adminLogin}`,
      maintainer_can_modify: true,
    });
    if (!prRes.ok) {
      // 422 with "No commits between" means nothing changed vs main
      return json({ error: 'pr_failed', detail: prRes.data }, 502);
    }
    pr = prRes.data;
  }

  // 5) Request review from the chosen reviewer(s)
  if (reviewers.length) {
    await gh(
      token, 'POST',
      `/repos/${owner}/${repo}/pulls/${pr.number}/requested_reviewers`,
      { reviewers }
    ).catch(() => {});

    // Also set them as ASSIGNEE(s) so the chosen person is visibly assigned
    // on the PR in GitHub (the requested-reviewer field alone doesn't show an
    // "Assignee"). This makes the assignment explicit in the GitHub UI.
    await gh(
      token, 'POST',
      `/repos/${owner}/${repo}/issues/${pr.number}/assignees`,
      { assignees: reviewers }
    ).catch(() => {});
  }

  // 6) Notify the admin (so they can see engagement / phone contributors)
  await gh(
    token, 'POST',
    `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
    { body: `🔔 @${cfg.adminLogin} — new edit from @${login} is ready for review.` }
  ).catch(() => {});

  return json({
    ok: true,
    prNumber: pr.number,
    prUrl: pr.html_url,
    branch,
    reviewers,
  });
}
