import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageBuilderService } from '../image-builder.service.js';
import { RegistryAuthService } from '../registry-auth.service.js';
import type { BuildBackend, RegistryAuth, RegistryConfig } from '../image-builder.interface.js';
import type { Service } from '@eve/shared';

describe('ImageBuilderService', () => {
  let service: ImageBuilderService;
  let mockRegistryAuth: RegistryAuthService;
  let mockBuilder: BuildBackend;

  const mockRegistryAuthData: RegistryAuth = {
    host: 'ghcr.io',
    username: 'testuser',
    token: 'test-token',
    dockerConfigJson: 'base64-encoded-config',
  };

  const mockRegistryConfigData: RegistryConfig = {
    host: 'ghcr.io',
    namespace: 'myorg',
    auth: {
      username_secret: 'GHCR_USERNAME',
      token_secret: 'GITHUB_TOKEN',
    },
  };

  beforeEach(() => {
    // Create mock RegistryAuthService
    mockRegistryAuth = {
      resolve: vi.fn().mockResolvedValue({
        auth: mockRegistryAuthData,
        config: mockRegistryConfigData,
      }),
    } as any;

    // Create mock BuildBackend
    mockBuilder = {
      buildService: vi.fn().mockResolvedValue('sha256:abc123'),
      buildAll: vi.fn(),
    };

    // Create service with mocks
    service = new ImageBuilderService(mockRegistryAuth, mockBuilder);
  });

  describe('buildAll', () => {
    it('calls builder.buildService for each buildable service', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
  worker:
    image: myorg/worker
    build:
      context: ./worker
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledTimes(2);
      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'api',
          service: expect.objectContaining({
            image: 'myorg/api',
            build: { context: './api' },
          }),
          gitSha: 'abc123def456',
          workspacePath: '/workspace',
        })
      );
      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'worker',
          service: expect.objectContaining({
            image: 'myorg/worker',
            build: { context: './worker' },
          }),
          gitSha: 'abc123def456',
          workspacePath: '/workspace',
        })
      );
    });

    it('returns image digests map', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
  worker:
    image: myorg/worker
    build:
      context: ./worker
`;

      mockBuilder.buildService = vi
        .fn()
        .mockResolvedValueOnce('sha256:api-digest')
        .mockResolvedValueOnce('sha256:worker-digest');

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      const result = await service.buildAll(params);

      expect(result).toEqual({
        imageDigests: {
          api: 'sha256:api-digest',
          worker: 'sha256:worker-digest',
        },
      });
    });

    it('uses correct tag format (sha-<gitSha[:12]>)', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456789012345678',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'sha-abc123def456',
        })
      );
    });

    it('uses custom tag when provided', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
        tag: 'v1.2.3',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'v1.2.3',
        })
      );
    });

    it('filters by components when provided', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
  worker:
    image: myorg/worker
    build:
      context: ./worker
  web:
    image: myorg/web
    build:
      context: ./web
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
        components: ['api', 'web'],
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledTimes(2);
      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: 'api' })
      );
      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: 'web' })
      );
      expect(mockBuilder.buildService).not.toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: 'worker' })
      );
    });

    it('resolves registry auth before building', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await service.buildAll(params);

      expect(mockRegistryAuth.resolve).toHaveBeenCalledWith('proj_123', manifestYaml);
      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          registryAuth: mockRegistryAuthData,
          registryConfig: mockRegistryConfigData,
        })
      );
    });

    it('handles empty buildable services (returns empty digests)', async () => {
      const manifestYaml = `
services:
  postgres:
    image: postgres:15
  redis:
    image: redis:7
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      const result = await service.buildAll(params);

      expect(result).toEqual({
        imageDigests: {},
      });
      expect(mockBuilder.buildService).not.toHaveBeenCalled();
    });

    it('handles empty buildable services when components filter excludes all', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
        components: ['worker', 'web'],
      };

      const result = await service.buildAll(params);

      expect(result).toEqual({
        imageDigests: {},
      });
      expect(mockBuilder.buildService).not.toHaveBeenCalled();
    });

    it('fails fast when a service build fails', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
  worker:
    image: myorg/worker
    build:
      context: ./worker
  web:
    image: myorg/web
    build:
      context: ./web
`;

      mockBuilder.buildService = vi
        .fn()
        .mockResolvedValueOnce('sha256:api-digest')
        .mockRejectedValueOnce(new Error('Build failed: Docker error'));

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await expect(service.buildAll(params)).rejects.toThrow(
        "Build failed for service 'worker': Build failed: Docker error"
      );

      // Should have stopped after the second build failed
      expect(mockBuilder.buildService).toHaveBeenCalledTimes(2);
    });

    it('throws on invalid manifest YAML', async () => {
      const manifestYaml = 'invalid: yaml: [[[';

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await expect(service.buildAll(params)).rejects.toThrow();
    });

    it('constructs correct imageRef with registry host and service image', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          imageRef: 'ghcr.io/myorg/api',
        })
      );
    });

    it('excludes services marked as external via x-eve', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
  external-db:
    image: myorg/db
    build:
      context: ./db
    x-eve:
      external: true
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledTimes(1);
      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: 'api' })
      );
      expect(mockBuilder.buildService).not.toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: 'external-db' })
      );
    });

    it('passes all required params to builder.buildService', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
      dockerfile: Dockerfile.prod
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace/path',
        projectId: 'proj_123',
        tag: 'custom-tag',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledWith({
        serviceName: 'api',
        service: expect.objectContaining({
          image: 'myorg/api',
          build: {
            context: './api',
            dockerfile: 'Dockerfile.prod',
          },
        }),
        registryConfig: mockRegistryConfigData,
        registryAuth: mockRegistryAuthData,
        gitSha: 'abc123def456',
        workspacePath: '/workspace/path',
        tag: 'custom-tag',
        imageRef: 'ghcr.io/myorg/api',
      });
    });

    it('handles services with minimal build config', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: .
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await service.buildAll(params);

      expect(mockBuilder.buildService).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'api',
          service: {
            image: 'myorg/api',
            build: {
              context: '.',
            },
          },
        })
      );
    });

    it('skips builds when registry is "none"', async () => {
      const manifestYaml = `
registry: "none"
services:
  api:
    image: myorg/api
    build:
      context: ./api
  worker:
    image: myorg/worker
    build:
      context: ./worker
`;

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      const result = await service.buildAll(params);

      expect(result).toEqual({ imageDigests: {} });
      expect(mockRegistryAuth.resolve).not.toHaveBeenCalled();
      expect(mockBuilder.buildService).not.toHaveBeenCalled();
    });

    it('handles non-Error exceptions during build', async () => {
      const manifestYaml = `
services:
  api:
    image: myorg/api
    build:
      context: ./api
`;

      mockBuilder.buildService = vi.fn().mockRejectedValueOnce('String error');

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      await expect(service.buildAll(params)).rejects.toThrow(
        "Build failed for service 'api': String error"
      );
    });

    it('returns digests in correct order', async () => {
      const manifestYaml = `
services:
  zebra:
    image: myorg/zebra
    build:
      context: ./zebra
  alpha:
    image: myorg/alpha
    build:
      context: ./alpha
  beta:
    image: myorg/beta
    build:
      context: ./beta
`;

      mockBuilder.buildService = vi
        .fn()
        .mockResolvedValueOnce('sha256:zebra-digest')
        .mockResolvedValueOnce('sha256:alpha-digest')
        .mockResolvedValueOnce('sha256:beta-digest');

      const params = {
        manifest: {} as any,
        manifestYaml,
        gitSha: 'abc123def456',
        workspacePath: '/workspace',
        projectId: 'proj_123',
      };

      const result = await service.buildAll(params);

      expect(result.imageDigests).toHaveProperty('zebra', 'sha256:zebra-digest');
      expect(result.imageDigests).toHaveProperty('alpha', 'sha256:alpha-digest');
      expect(result.imageDigests).toHaveProperty('beta', 'sha256:beta-digest');
    });
  });
});
