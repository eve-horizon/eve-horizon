import { Manifest, Service } from '@eve/shared';

export interface RegistryAuth {
  host: string;
  username: string;
  token: string;
  /** Base64-encoded Docker config JSON for registry auth */
  dockerConfigJson: string;
}

export interface RegistryConfig {
  host: string;
  namespace?: string;
  auth?: {
    username_secret?: string;
    token_secret?: string;
  };
}

export interface BuildServiceParams {
  serviceName: string;
  service: Service;
  registryConfig: RegistryConfig;
  registryAuth: RegistryAuth;
  gitSha: string;
  workspacePath: string;
  tag: string;
  /** Full image ref including registry host/namespace, e.g. ghcr.io/org/app */
  imageRef: string;
  repoUrl?: string;
  onLog?: (message: string) => void;
}

export interface BuildAllParams {
  manifest: Manifest;
  manifestYaml: string;
  gitSha: string;
  workspacePath: string;
  projectId: string;
  components?: string[];
  tag?: string;
  repoUrl?: string;
  onLog?: (message: string) => void;
}

export interface BuildResult {
  /** Map of service name to pushed image digest (sha256:...) */
  imageDigests: Record<string, string>;
}

export interface BuildBackend {
  /** Build and push all buildable services, return their digests */
  buildAll(params: BuildAllParams): Promise<BuildResult>;

  /** Build and push a single service, return its digest */
  buildService(params: BuildServiceParams): Promise<string>;
}

export const BUILD_BACKEND = Symbol('BUILD_BACKEND');
