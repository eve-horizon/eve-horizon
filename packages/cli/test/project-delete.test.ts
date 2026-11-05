import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleProject } from '../src/commands/project';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
  requestRaw: vi.fn(),
}));

import { requestJson, requestRaw } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: 'proj_profile_default',
};

describe('eve project delete', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
    vi.mocked(requestRaw).mockReset();
  });

  it('soft-deletes the named project', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleProject('delete', ['proj_1'], {}, context as never);

    expect(requestJson).toHaveBeenCalledWith(context, '/projects/proj_1', { method: 'DELETE' });
    expect(log).toHaveBeenCalledWith('✓ Project proj_1 soft-deleted');
  });

  it('passes --hard and --force through as query flags', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleProject('delete', ['proj_1'], { hard: true, force: true, json: true }, context as never);

    expect(requestJson).toHaveBeenCalledWith(context, '/projects/proj_1?hard=true&force=true', { method: 'DELETE' });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      project_id: 'proj_1',
      deleted: true,
      mode: 'hard-deleted',
    });
  });

  it('accepts --project instead of a positional id', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(null);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleProject('delete', [], { project: 'proj_2', hard: true }, context as never);

    expect(requestJson).toHaveBeenCalledWith(context, '/projects/proj_2?hard=true', { method: 'DELETE' });
  });

  it('never falls back to the profile default project', async () => {
    await expect(handleProject('delete', [], { hard: true }, context as never)).rejects.toThrow(
      'Usage: eve project delete <project_id> [--hard] [--force]',
    );
    expect(requestJson).not.toHaveBeenCalled();
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it('reports a refused delete as an error, not a success', async () => {
    vi.mocked(requestJson).mockRejectedValueOnce(
      new Error('HTTP 409: while calling DELETE /projects/proj_1?hard=true: Project proj_1 has managed databases that are not destroyed'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(handleProject('delete', ['proj_1'], { hard: true }, context as never)).rejects.toThrow('HTTP 409');
    expect(log).not.toHaveBeenCalled();
  });
});
