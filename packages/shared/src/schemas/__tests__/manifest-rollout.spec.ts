import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../manifest.js';

describe('manifest service x-eve.rollout', () => {
  it('accepts recreate and rolling', () => {
    const parsed = ManifestSchema.parse({
      services: {
        api: { image: 'example/api:latest', 'x-eve': { rollout: 'recreate' } },
        web: { image: 'example/web:latest', 'x-eve': { rollout: 'rolling' } },
      },
    });

    expect(parsed.services?.api?.['x-eve']?.rollout).toBe('recreate');
    expect(parsed.services?.web?.['x-eve']?.rollout).toBe('rolling');
  });

  it('rejects values outside recreate | rolling', () => {
    const result = ManifestSchema.safeParse({
      services: {
        api: { image: 'example/api:latest', 'x-eve': { rollout: 'blue-green' } },
      },
    });

    expect(result.success).toBe(false);
  });
});
