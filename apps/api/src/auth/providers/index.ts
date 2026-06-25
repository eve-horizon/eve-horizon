export type {
  IdentityProvider,
  ChallengeData,
  ChallengeProof,
  VerifiedIdentity,
  ExtractedCredential,
} from './identity-provider.interface.js';

export { IdentityProviderRegistry } from './provider-registry.js';
export { SshIdentityProvider, fingerprintPublicKey } from './ssh-identity.provider.js';
export { NostrIdentityProvider } from './nostr-identity.provider.js';
