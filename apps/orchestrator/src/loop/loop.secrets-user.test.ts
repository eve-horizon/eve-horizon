import { describe, expect, it } from 'vitest';
import * as loop from './loop.service';

type SecretsUserIdForJob = (job: { actor_user_id: string | null; user_secrets_excluded?: boolean }) => string | undefined;

/** The user whose user-scope secrets a job's invocation may resolve. */
const secretsUserIdForJob = (loop as unknown as { secretsUserIdForJob: SecretsUserIdForJob }).secretsUserIdForJob;

describe('secretsUserIdForJob', () => {
  it("is the job's actor for work a person started", () => {
    expect(secretsUserIdForJob({ actor_user_id: 'user_owner', user_secrets_excluded: false })).toBe('user_owner');
  });

  it('is no one for work started with an org-bound token, whoever owns the account later', () => {
    expect(secretsUserIdForJob({ actor_user_id: 'user_bot', user_secrets_excluded: true })).toBeUndefined();
  });

  it('is no one when no user started the work', () => {
    expect(secretsUserIdForJob({ actor_user_id: null, user_secrets_excluded: false })).toBeUndefined();
  });
});
