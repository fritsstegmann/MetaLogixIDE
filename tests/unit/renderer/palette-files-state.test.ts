/**
 * The palette's async file provider (AC34, AC36): `paletteFilesReducer` moves idle → loading →
 * ready | error, goes straight to `no-project` (and so never to `loading`, which is what triggers
 * the IPC call) without a project, and reuses a loaded or in-flight list when "@" is re-entered.
 * `loadPaletteFiles` maps the `files:list-all` response to the next event, logging failures.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PALETTE_FILE_LIMIT, type PaletteFilesState } from '@renderer/command-palette-contract';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));

const { paletteFilesReducer, loadPaletteFiles } = await import('@renderer/hooks/usePaletteFiles');

const IDLE: PaletteFilesState = { status: 'idle' };
const FILES = [{ relPath: 'a.ts', name: 'a.ts' }];
const READY: PaletteFilesState = { status: 'ready', files: FILES, truncated: true };

afterEach(() => { vi.restoreAllMocks(); });

describe('paletteFilesReducer', () => {
  it('starts loading when "@" is entered with a project', () => {
    expect(paletteFilesReducer(IDLE, { type: 'enter', projectId: 7 })).toEqual({ status: 'loading' });
  });

  it('goes to no-project, not loading, when "@" is entered without a project (AC36)', () => {
    expect(paletteFilesReducer(IDLE, { type: 'enter', projectId: null })).toEqual({ status: 'no-project' });
  });

  it('becomes ready with the files and the truncated flag once loaded', () => {
    const next = paletteFilesReducer({ status: 'loading' }, { type: 'loaded', files: FILES, truncated: true });
    expect(next).toEqual(READY);
  });

  it('becomes error when loading fails', () => {
    expect(paletteFilesReducer({ status: 'loading' }, { type: 'failed' })).toEqual({ status: 'error' });
  });

  it('reuses a loaded list when "@" is re-entered (AC34)', () => {
    expect(paletteFilesReducer(READY, { type: 'enter', projectId: 7 })).toBe(READY);
  });

  it('does not restart a load that is in flight', () => {
    const loading: PaletteFilesState = { status: 'loading' };
    expect(paletteFilesReducer(loading, { type: 'enter', projectId: 7 })).toBe(loading);
  });

  it('retries after an error on re-entry', () => {
    expect(paletteFilesReducer({ status: 'error' }, { type: 'enter', projectId: 7 })).toEqual({ status: 'loading' });
  });

  it('ignores a late result after a reset', () => {
    expect(paletteFilesReducer(IDLE, { type: 'loaded', files: FILES, truncated: false })).toBe(IDLE);
    expect(paletteFilesReducer(IDLE, { type: 'failed' })).toBe(IDLE);
  });

  it('forgets the list on reset (palette closed or project changed)', () => {
    expect(paletteFilesReducer(READY, { type: 'reset' })).toEqual(IDLE);
  });
});

describe('loadPaletteFiles', () => {
  it('asks files:list-all for the project with the 5000-file limit and returns a loaded event', async () => {
    const list = vi.fn().mockResolvedValue({ files: FILES, total: 9000, truncated: true });
    await expect(loadPaletteFiles(7, list)).resolves.toEqual({ type: 'loaded', files: FILES, truncated: true });
    expect(list).toHaveBeenCalledWith({ projectId: 7, limit: PALETTE_FILE_LIMIT });
  });

  it('logs the error and returns a failed event when listing rejects (AC36)', async () => {
    const err = new Error('nope');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(loadPaletteFiles(7, vi.fn().mockRejectedValue(err))).resolves.toEqual({ type: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.anything(), err);
  });
});
