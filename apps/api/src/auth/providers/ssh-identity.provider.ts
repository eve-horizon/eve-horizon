import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import type { Identity } from '@eve/db';
import type {
  IdentityProvider,
  ChallengeData,
  ChallengeProof,
  VerifiedIdentity,
} from './identity-provider.interface.js';

/**
 * SSH-key identity provider.
 *
 * Authentication flow:
 *   1. Server issues a random nonce (`createChallenge`).
 *   2. Client signs the nonce with `ssh-keygen -Y sign`.
 *   3. Server verifies the signature against stored public keys
 *      using `ssh-keygen -Y verify` (`verifyChallenge`).
 *
 * SSH does not support request-level auth (no extractFromRequest).
 */
@Injectable()
export class SshIdentityProvider implements IdentityProvider {
  readonly name = 'github_ssh';

  async createChallenge(_params: { userId?: string; pubkey?: string }): Promise<ChallengeData> {
    const nonce = randomBytes(32).toString('base64url');
    return { nonce };
  }

  async verifyChallenge(
    challenge: string,
    proof: ChallengeProof,
    identities: Identity[],
  ): Promise<VerifiedIdentity | null> {
    const principal = (proof.principal as string | undefined) ?? '';

    for (const identity of identities) {
      if (this.verifySshSignature(identity.public_key, challenge, proof.signature, principal)) {
        return {
          provider: this.name,
          externalId: identity.fingerprint,
          identity,
          userId: identity.user_id,
        };
      }
    }

    return null;
  }

  async fingerprint(publicKey: string): Promise<string> {
    return fingerprintPublicKey(publicKey);
  }

  // ---- Internal helpers ----

  private verifySshSignature(
    publicKey: string,
    nonce: string,
    signature: string,
    principal: string,
  ): boolean {
    const tmpDir = mkdtempSync(join(tmpdir(), 'eve-ssh-'));
    const allowedSignersPath = join(tmpDir, 'allowed_signers');
    const signaturePath = join(tmpDir, 'signature');

    try {
      writeFileSync(allowedSignersPath, `${principal} ${publicKey}\n`);
      writeFileSync(signaturePath, signature);

      // ssh-keygen -Y verify reads the message from stdin, not as a positional argument
      const result = spawnSync(
        'ssh-keygen',
        ['-Y', 'verify', '-f', allowedSignersPath, '-I', principal, '-n', 'eve-auth', '-s', signaturePath],
        { input: nonce, encoding: 'utf8' },
      );

      return result.status === 0;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---- Standalone helper (also used by auth.service.ts during transition) ----

/**
 * Compute the SSH fingerprint of a public key using `ssh-keygen -lf`.
 *
 * Exported so auth.service.ts can continue calling it directly during the
 * transition period. Once all callers go through the provider, this can
 * become a private method.
 */
export function fingerprintPublicKey(publicKey: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'eve-auth-'));
  const keyPath = join(tmpDir, 'key.pub');
  try {
    writeFileSync(keyPath, publicKey);
    const result = spawnSync('ssh-keygen', ['-lf', keyPath], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`ssh-keygen failed: ${result.stderr || 'unknown error'}`);
    }
    const parts = result.stdout.trim().split(' ');
    if (parts.length < 2) {
      throw new Error('Failed to parse ssh-keygen output');
    }
    return parts[1];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
