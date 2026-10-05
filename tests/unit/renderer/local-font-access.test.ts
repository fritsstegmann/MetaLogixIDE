import { describe, expect, it, vi } from 'vitest';
import { discoverLocalFonts } from '../../../src/renderer/fonts/local-font-access';

/** Contract tests for permission-sensitive installed-font metadata discovery. */
describe('discoverLocalFonts', () => {
  it('reports unsupported without invoking anything when the API is absent', async () => {
    await expect(discoverLocalFonts({})).resolves.toEqual({ status: 'unsupported' });
  });

  it('extracts only family metadata, deduplicates case-insensitively, and sorts case-insensitively', async () => {
    const blob = vi.fn();
    const queryLocalFonts = vi.fn().mockResolvedValue([
      { family: 'zeta', fullName: 'zeta regular', blob },
      { family: 'Alpha', postscriptName: 'Alpha-Regular' },
      { family: 'ALPHA' },
      { family: 'Éclair Sans' },
      { family: 'Beta, "Quoted"; Font\\Name' },
      { family: 42 },
      null,
    ]);

    await expect(discoverLocalFonts({ queryLocalFonts })).resolves.toEqual({
      status: 'success',
      families: ['Alpha', 'Beta, "Quoted"; Font\\Name', 'Éclair Sans', 'zeta'],
    });
    expect(queryLocalFonts).toHaveBeenCalledOnce();
    expect(queryLocalFonts).toHaveBeenCalledWith();
    expect(blob).not.toHaveBeenCalled();
  });

  it.each(['NotAllowedError', 'SecurityError'])('reports %s as denied without exposing error details', async (name) => {
    const queryLocalFonts = vi.fn().mockRejectedValue(new DOMException('host detail', name));

    await expect(discoverLocalFonts({ queryLocalFonts })).resolves.toEqual({ status: 'denied' });
  });

  it('reports other thrown values as an opaque error', async () => {
    const queryLocalFonts = vi.fn().mockRejectedValue(new Error('private host detail'));

    await expect(discoverLocalFonts({ queryLocalFonts })).resolves.toEqual({ status: 'error' });
  });
});
