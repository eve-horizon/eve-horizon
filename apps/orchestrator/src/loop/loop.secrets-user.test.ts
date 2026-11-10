import { describe, expect, it } from 'vitest';
import { secretsUserIdForJob } from './loop.service';

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
