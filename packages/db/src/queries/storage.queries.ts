import type { Db } from '../client.js';

export type StorageProvider = 'minio' | 's3' | 'gcs' | 'r2' | 'tigris';

export interface StorageBackend {
  id: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  public_endpoint: string | null;
  region: string;
  is_default: boolean;
  created_at: Date;
}

export interface CreateStorageBackendInput {
  id: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  public_endpoint?: string | null;
  region?: string;
  is_default?: boolean;
}

export function storageQueries(db: Db) {
  return {
    async findDefault(): Promise<StorageBackend | null> {
      const [row] = await db<StorageBackend[]>`
        SELECT * FROM storage_backends WHERE is_default = true LIMIT 1
      `;
      return row ?? null;
    },

    async list(): Promise<StorageBackend[]> {
      return db<StorageBackend[]>`
        SELECT * FROM storage_backends ORDER BY created_at ASC
      `;
    },

    async create(input: CreateStorageBackendInput): Promise<StorageBackend> {
      const publicEndpoint = input.public_endpoint ?? null;
      const region = input.region ?? 'us-east-1';
      const isDefault = input.is_default ?? false;
      const [row] = await db<StorageBackend[]>`
        INSERT INTO storage_backends (
          id, name, provider, endpoint, public_endpoint, region, is_default
        ) VALUES (
          ${input.id},
          ${input.name},
          ${input.provider},
          ${input.endpoint},
          ${publicEndpoint},
          ${region},
          ${isDefault}
        )
        RETURNING *
      `;
      return row;
    },
  };
}
