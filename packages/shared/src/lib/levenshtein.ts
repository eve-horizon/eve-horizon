/**
 * Compute the Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

/**
 * Find close matches for a target string among candidates.
 * Case-insensitive. Returns candidates with distance <= maxDistance, sorted by distance.
 */
export function findClosestMatches(
  target: string,
  candidates: Iterable<string>,
  maxDistance = 2,
): string[] {
  const results: { candidate: string; distance: number }[] = [];

  for (const candidate of candidates) {
    if (Math.abs(target.length - candidate.length) > maxDistance) continue;

    const distance = levenshteinDistance(
      target.toUpperCase(),
      candidate.toUpperCase(),
    );

    if (distance > 0 && distance <= maxDistance) {
      results.push({ candidate, distance });
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  return results.map((r) => r.candidate);
}
