/**
 * GET /api/repo/collaborators
 * Returns the list of collaborators on the shared repo, for the reviewer
 * dropdown shown when a user submits for review. Excludes the current user
 * (you can't request review from yourself).
 *
 * Returns: { collaborators: [{ login }] }
 */
import { gh, getToken, getLogin, getConfig, json } from '../_gh.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = getToken(request);
  const login = getLogin(request);
  if (!token || !login) return json({ error: 'not_authenticated' }, 401);

  const cfg = getConfig(env);
  const res = await gh(
    token, 'GET',
    `/repos/${cfg.upstreamOwner}/${cfg.upstreamRepo}/collaborators?per_page=100`
  );
  if (!res.ok) {
    // fall back to the configured default reviewers if we can't list collaborators
    return json({
      collaborators: cfg.reviewers.filter((r) => r !== login).map((r) => ({ login: r })),
      fallback: true,
    });
  }
  const collaborators = (Array.isArray(res.data) ? res.data : [])
    .map((c) => ({ login: c.login }))
    .filter((c) => c.login !== login);

  return json({ collaborators });
}
