import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';

const db = vi.hoisted(() => ({
  ingests: { create: vi.fn() },
  projects: { findById: vi.fn() },
  orgs: { findById: vi.fn() },
}));

vi.mock('@eve/db', () => ({
  ingestRecordQueries: vi.fn(() => db.ingests),
  projectQueries: vi.fn(() => db.projects),
  orgQueries: vi.fn(() => db.orgs),
}));

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async (host: string, options?: { all?: boolean }) => {
    const table: Record<string, string> = { 'hooks.example.com': '93.184.216.34', 'internal.example.com': '10.0.0.7' };
    const address = table[host.replace(/\.$/, '')];
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const answer = { address, family: 4 };
    return options?.all ? [answer] : answer;
  });
  return { lookup, default: { lookup } };
});

import { IngestService } from './ingest.service';

describe('ingest callback_url', () => {
  let service: IngestService;
  const storage = {
    ensureOrgBucket: vi.fn(async () => 'bucket'),
    getPresignedUploadUrl: vi.fn(async () => 'https://storage.example.com/upload'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.projects.findById.mockResolvedValue({ id: 'proj_1', org_id: 'org_1' });
    db.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    db.ingests.create.mockImplementation(async (row: { id: string }) => row);
    service = new IngestService({} as never, storage as never, {} as never);
  });

  const create = (callbackUrl: string) =>
    service.create('proj_1', { file_name: 'notes.pdf', mime_type: 'application/pdf', size_bytes: 1024, callback_url: callbackUrl }, 'user', 'user_1');

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/hook',
    'http://127.0.0.1:8080/hook',
    'http://localhost:8080/hook',
    'https://internal.example.com/hook',
    'ftp://hooks.example.com/hook',
  ])('refuses %s with 400', async (callbackUrl) => {
    const error = await create(callbackUrl).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(400);
    expect(db.ingests.create).not.toHaveBeenCalled();
  });

  it('accepts a public https URL', async () => {
    await expect(create('https://hooks.example.com/ingest')).resolves.toMatchObject({ upload_method: 'PUT' });
    expect(db.ingests.create).toHaveBeenCalledWith(expect.objectContaining({ callback_url: 'https://hooks.example.com/ingest' }));
  });
});
