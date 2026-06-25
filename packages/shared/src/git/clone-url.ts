/**
 * Build an authenticated HTTPS clone URL for a GitHub repository.
 *
 * GitHub's HTTPS git endpoint accepts a token differently depending on the
 * token kind:
 *
 * - Classic PATs (`ghp_…`) authenticate in either the username or the password
 *   field.
 * - Fine-grained PATs (`github_pat_…`), GitHub App installation tokens
 *   (`ghs_…`), and OAuth tokens (`gho_…`) authenticate ONLY when supplied as
 *   the password, with a non-empty username.
 *
 * Putting the token in the username field with an empty password — the historical
 * Eve behaviour, `https://<token>@github.com/...` — therefore works for classic
 * PATs but silently fails for every other token kind: GitHub returns 401, git
 * decides it has a username but no password, and prompts for one, which hangs or
 * fails in a non-interactive job runner.
 *
 * The canonical `x-access-token:<token>` form works for ALL token kinds, so we
 * always use it. The token is trimmed because a trailing newline in a stored
 * secret would otherwise be percent-encoded into the password and corrupt auth.
 *
 * The original URL is returned unchanged when auth cannot be applied:
 * - the URL is not HTTP(S), or
 * - the host is not github.com, or
 * - the URL cannot be parsed, or
 * - the token is empty after trimming.
 *
 * @param repoUrl - the repository URL (e.g. `https://github.com/org/repo.git`)
 * @param token - the GitHub token value
 * @returns the authenticated clone URL, or `repoUrl` when auth cannot be applied
 */
export function buildAuthenticatedHttpsUrl(repoUrl: string, token: string): string {
  if (!repoUrl.startsWith('http')) return repoUrl;

  const trimmed = token.trim();
  if (!trimmed) return repoUrl;

  try {
    const url = new URL(repoUrl);
    if (!url.hostname.includes('github.com')) return repoUrl;
    url.username = 'x-access-token';
    url.password = trimmed;
    return url.toString();
  } catch {
    return repoUrl;
  }
}
