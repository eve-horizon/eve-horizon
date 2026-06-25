/**
 * Patterns that indicate an authentication error.
 * Used to provide helpful error messages directing users to re-authenticate.
 */
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /authentication[_\s-]?error/i,
  /authentication failed/i,
  /unauthorized/i,
  /forbidden/i,
  /\b401\b/,
  /\b403\b/,
  /invalid authentication credentials/i,
  /token has expired/i,
  /token expired/i,
  /oauth token/i,
  /api key/i,
  /invalid_grant/i,
  /run \/login/i,
  /code login/i,
  /missing field [`"]?id_token[`"]?/i,
];

/**
 * Check if an error message indicates an authentication problem.
 * Used to provide helpful remediation instructions.
 */
export function isAuthErrorMessage(message?: string): boolean {
  if (!message) return false;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
