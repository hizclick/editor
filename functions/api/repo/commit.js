/**
 * POST /api/repo/commit
 * Shared-repo model (no forks). Commits the edited TEI (and any new photos) to
 * the signed-in user's own branch (edit-{login}) inside the same repo — WITHOUT
 * opening a Pull Request. This is the plain "save to my branch" action; use
 * /api/repo/save when the user is ready to submit for review.
 *
 * Body: {
 *   content:  string  (edited TEI xml),
 *   message:  string  (optional commit message),
 *   photos:   [{ name, dataUrl }]  (optional new images)
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
      message: body.message || `Save by ${login}`,
      content: utf8ToBase64(content),
      sha: teiSha,
      branch,
    }
  );
  if (!putTei.ok) return json({ error: 'commit_failed', message: githubMessage(putTei), detail: putTei.data }, 502);

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

  return json({
    ok: true,
    branch,
    commit: putTei.data && putTei.data.commit ? putTei.data.commit.sha : undefined,
  });
}
