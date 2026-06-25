import type { Identity } from '@eve/db';

// ---- Supporting types ----

/**
 * Data returned when a provider creates a challenge for the client.
 * The shape is provider-specific (SSH returns a nonce, OAuth would return
 * a redirect URL, etc.), so we keep it intentionally open.
 */
export interface ChallengeData {
  /** Opaque nonce or challenge string the client must sign / respond to. */
  nonce: string;
  /** Any extra fields the provider needs the client to echo back. */
  [key: string]: unknown;
}

/**
 * Proof submitted by the client to complete a challenge.
 */
export interface ChallengeProof {
  /** The signed/encrypted response. */
  signature: string;
  /** Provider-specific extras (e.g. the principal used for SSH verify). */
  [key: string]: unknown;
}

/**
 * Returned by a provider after successful verification.
 * Contains enough information for the auth service to mint a token.
 *
 * Two shapes:
 * 1. Known identity: `identity` is set (challenge-response with registered user)
 * 2. Unknown identity: `identity` is null, `provider`/`externalId` identify the caller
 *    (request-level auth from an unregistered pubkey — needs invite lookup)
 */
export interface VerifiedIdentity {
  /** Provider name (always set). */
  provider: string;
  /** External identifier: fingerprint, pubkey hex, etc. (always set). */
  externalId: string;
  /** The identity row that matched (null if unregistered). */
  identity: Identity | null;
  /** Eve user ID if resolved (set when identity is non-null). */
  userId?: string;
  /** Display name hint for provisioning. */
  displayName?: string;
  /** Provider-specific or flow-specific metadata (e.g., invite_code). */
  metadata?: Record<string, unknown>;
}

/**
 * Credential extracted from an incoming HTTP request (e.g. an API key header,
 * an OAuth bearer token, a client certificate fingerprint).
 */
export interface ExtractedCredential {
  /** Which provider extracted this credential. */
  providerName: string;
  /** Raw credential value. */
  value: string;
  /** Provider-specific extras. */
  [key: string]: unknown;
}

// ---- Provider contract ----

/**
 * An IdentityProvider knows how to authenticate users via a single mechanism.
 *
 * Lifecycle:
 *   1. Client calls `createChallenge` (e.g. "I want to log in with SSH key X").
 *   2. Server stores the challenge and returns it.
 *   3. Client signs the challenge and calls `verifyChallenge`.
 *   4. Provider checks the proof against known identities and returns
 *      the matching identity row — or null if verification fails.
 *
 * Request-level auth (optional):
 *   Some providers (API keys, OAuth tokens) can authenticate a request
 *   directly without the challenge/response dance.  They implement
 *   `extractFromRequest` + `verifyRequestCredential`.
 */
export interface IdentityProvider {
  /** Matches the `identities.provider` column (e.g. `'github_ssh'`). */
  readonly name: string;

  /**
   * Create a challenge for the given user/pubkey combination.
   * Providers that don't support challenge/response may throw.
   */
  createChallenge(params: { userId?: string; pubkey?: string }): Promise<ChallengeData>;

  /**
   * Verify a completed challenge.
   *
   * @param challenge  The nonce/payload that was issued.
   * @param proof      The client's proof (signature, etc.).
   * @param identities The identity rows the user has for this provider.
   * @returns The matching identity, or `null` if none verified.
   */
  verifyChallenge(
    challenge: string,
    proof: ChallengeProof,
    identities: Identity[],
  ): Promise<VerifiedIdentity | null>;

  /**
   * Compute a deterministic fingerprint for a public key.
   * Used to de-duplicate identity registrations.
   */
  fingerprint(publicKey: string): Promise<string>;

  // ---- Optional: request-level auth ----

  /**
   * Inspect an incoming request and extract a credential if present.
   * Return `null` if the request doesn't carry this provider's credential.
   */
  extractFromRequest?(req: { headers: Record<string, string | string[] | undefined> }): ExtractedCredential | null;

  /**
   * Verify a credential previously extracted by `extractFromRequest`.
   */
  verifyRequestCredential?(credential: ExtractedCredential): Promise<VerifiedIdentity | null>;
}
