import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../manifest.js';

describe('manifest HTTP ingress tuning', () => {
  it('accepts timeout and max_body_size fields under x-eve.ingress', () => {
    const parsed = ManifestSchema.parse({
      services: {
        web: {
          image: 'web:latest',
          ports: [3000],
          'x-eve': {
            ingress: {
              public: true,
              port: 3000,
              timeout: '600s',
              max_body_size: '100m',
            },
          },
        },
      },
    });

    expect(parsed.services.web['x-eve']?.ingress?.timeout).toBe('600s');
    expect(parsed.services.web['x-eve']?.ingress?.max_body_size).toBe('100m');
  });

  it('rejects out-of-range tuning values with actionable messages', () => {
    const parsed = ManifestSchema.safeParse({
      services: {
        web: {
          image: 'web:latest',
          ports: [3000],
          'x-eve': {
            ingress: {
              timeout: '2h',
              max_body_size: '5g',
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message).join('\n');
      expect(messages).toContain('for longer work use Eve jobs');
      expect(messages).toContain('signed-URL upload');
    }
  });
});
