import { describe, expect, it } from 'vitest';
import { getServiceObjectStoreBuckets, getServiceObjectStoreIsolation, ManifestSchema } from '../manifest.js';

describe('manifest object store buckets', () => {
  it('validates service object_store bucket declarations', () => {
    const parsed = ManifestSchema.parse({
      name: 'media-app',
      services: {
        api: {
          image: 'ghcr.io/example/api:latest',
          'x-eve': {
            object_store: {
              isolation: 'irsa',
              buckets: [
                {
                  name: 'media',
                  visibility: 'private',
                  cors: {
                    origins: ['*'],
                    methods: ['PUT', 'HEAD', 'GET'],
                    max_age_seconds: 3600,
                  },
                },
              ],
            },
          },
        },
      },
    });

    const service = parsed.services?.api;
    expect(service).toBeDefined();
    expect(getServiceObjectStoreIsolation(service!)).toBe('irsa');
    expect(getServiceObjectStoreBuckets(service!)).toEqual([
      {
        name: 'media',
        visibility: 'private',
        cors: {
          origins: ['*'],
          methods: ['PUT', 'HEAD', 'GET'],
          max_age_seconds: 3600,
        },
      },
    ]);
  });

  it('rejects invalid bucket names', () => {
    expect(() => ManifestSchema.parse({
      name: 'media-app',
      services: {
        api: {
          image: 'ghcr.io/example/api:latest',
          'x-eve': {
            object_store: {
              buckets: [{ name: 'Media_Uploads' }],
            },
          },
        },
      },
    })).toThrow('Bucket name must be lowercase alphanumeric with hyphens');
  });

  it('defaults missing object_store isolation through the helper', () => {
    const parsed = ManifestSchema.parse({
      name: 'media-app',
      services: {
        api: {
          image: 'ghcr.io/example/api:latest',
          'x-eve': {
            object_store: {
              buckets: [{ name: 'media' }],
            },
          },
        },
      },
    });

    expect(getServiceObjectStoreIsolation(parsed.services!.api!)).toBe('auto');
  });
});
