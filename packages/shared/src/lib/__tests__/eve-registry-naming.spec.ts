import { describe, expect, it } from 'vitest';
import {
  eveRegistryImageRef,
  eveRegistryRepositoryPrefix,
  resolveBuildImageRef,
} from '../manifest-accessors.ts';

const HOST = 'registry.eve.example.com';
const PROJECT = 'proj_01hshop';

describe('Eve registry project namespacing', () => {
  it('uses the project id as the repository prefix', () => {
    expect(eveRegistryRepositoryPrefix(PROJECT)).toBe('proj_01hshop/');
    expect(() => eveRegistryRepositoryPrefix('Proj_Upper')).toThrow();
    expect(() => eveRegistryRepositoryPrefix('../x')).toThrow();
  });

  it('places any spelling of an image under the project prefix, once', () => {
    expect(eveRegistryImageRef('api', HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/api`);
    expect(eveRegistryImageRef('acme/api:v1', HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/acme/api:v1`);
    expect(eveRegistryImageRef(`${HOST}/api`, HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/api`);
    expect(eveRegistryImageRef(`${HOST}/proj_01hshop/api`, HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/api`);
    expect(eveRegistryImageRef('proj_01hshop/api', HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/api`);
  });

  it('keeps another project\'s prefix inside this project\'s namespace', () => {
    expect(eveRegistryImageRef('proj_01hvictim/api', HOST, PROJECT)).toBe(
      `${HOST}/proj_01hshop/proj_01hvictim/api`,
    );
    expect(eveRegistryImageRef(`${HOST}/proj_01hvictim/api`, HOST, PROJECT)).toBe(
      `${HOST}/proj_01hshop/proj_01hvictim/api`,
    );
  });
});

describe('resolveBuildImageRef', () => {
  it('namespaces bare images and images on the Eve registry host for Eve builds', () => {
    expect(resolveBuildImageRef('api', HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/api`);
    expect(resolveBuildImageRef(`${HOST}/victim-api`, HOST, PROJECT)).toBe(`${HOST}/proj_01hshop/victim-api`);
  });

  it('leaves images on other registries as written', () => {
    expect(resolveBuildImageRef('ghcr.io/acme/api', HOST, PROJECT)).toBe('ghcr.io/acme/api');
    expect(resolveBuildImageRef('localhost/api', HOST, PROJECT)).toBe('localhost/api');
  });

  it('keeps the previous behaviour for other registries', () => {
    expect(resolveBuildImageRef('api', 'ghcr.io/acme')).toBe('ghcr.io/acme/api');
    expect(resolveBuildImageRef('ghcr.io/acme/api', 'ghcr.io/acme')).toBe('ghcr.io/acme/api');
  });
});
