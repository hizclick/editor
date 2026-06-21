/**
 * GET /api/repo/load
 * Shared-repo model (no forks). Reads the TEI from the signed-in user's own
 * branch (edit-{login}) inside hizclick/welde-mariam-digital-edition.
 *
 * If the user's branch doesn't exist yet, it is created from main first, so the
 * user always starts from the latest merged content; thereafter their branch is
 * their persistent workspace and we always read from it.
 *
 * Returns: { content (xml), sha, path, branch }
 */
import { gh, getToken, getLogin, getConfig, userBranch, json, base64ToUtf8, githubMessage, resolveBaseRef } from '../_gh.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return json({ error: 'not_authenticated' }, 401);

  const cfg = getConfig(env);
  const owner = cfg.upstreamOwner;
  const repo = cfg.upstreamRepo;
  const branch = userBranch(login);

  // Diagnostics: verify the token works at all and that this account can see the repo.
  const who = await gh(token, 'GET', '/user');
  const repoCheck = await gh(token, 'GET', `/repos/${owner}/${repo}`);
  console.log('[load] login(cookie)=%s token.user=%s tokenOk=%s | repo %s/%s status=%s default_branch=%s',
    login,
    who.ok ? who.data.login : '(token invalid)',
    who.ok,
    owner, repo, repoCheck.status,
    repoCheck.ok ? repoCheck.data.default_branch : '(no access)');
  if (!who.ok) {
    return json({ error: 'bad_token', message: 'Your GitHub session token is invalid or expired. Sign out and sign in again.' }, 401);
  }
  if (!repoCheck.ok) {
    const msg = repoCheck.status === 404
      ? `@${who.data.login} cannot see ${owner}/${repo}. Either the repo name is wrong, or @${who.data.login} is not a collaborator on this private repo. Add them: repo → Settings → Collaborators.`
      : (githubMessage(repoCheck) || `Cannot access ${owner}/${repo} (HTTP ${repoCheck.status}).`);
    return json({ error: 'repo_unavailable', message: msg, status: repoCheck.status }, repoCheck.status === 404 ? 404 : 502);
  }

  // 1) Does the user's branch exist?
  let branchRef = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);

  // 2) If not, create it from the base branch's latest commit
  if (!branchRef.ok) {
    const base = await resolveBaseRef(token, owner, repo, cfg.upstreamBranch);
    if (!base.ok) {
      const httpStatus = base.status === 404 ? 404 : 502;
      return json({ error: base.error, message: base.message, status: base.status }, httpStatus);
    }
    const created = await gh(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: base.ref.object.sha,
    });
    if (!created.ok && created.status !== 422) {
      return json({ error: 'branch_create_failed', message: githubMessage(created), detail: created.data }, 502);
    }
  }

  // 3) Read the TEI file from the user's branch
  const fileRes = await gh(
    token, 'GET',
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(cfg.teiPath)}?ref=${branch}`
  );
  if (!fileRes.ok) {
    const message = fileRes.status === 404
      ? `The file "${cfg.teiPath}" was not found in ${owner}/${repo}. Check TEI_PATH or commit the file first.`
      : (githubMessage(fileRes) || 'Could not read the document from GitHub.');
    return json({ error: 'load_failed', status: fileRes.status, message, detail: fileRes.data, path: cfg.teiPath, branch }, fileRes.status);
  }

  return json({
    content: base64ToUtf8(fileRes.data.content || ''),
    sha: fileRes.data.sha,
    path: cfg.teiPath,
    branch,
  });
}
