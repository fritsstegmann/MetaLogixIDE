import { describe, expect, it, vi } from 'vitest';
import { findForegroundClaude, PosixForegroundObserver } from '@main/agent-status/foreground-posix';

const ps = '100 1 100 203 zsh /bin/zsh -l\n201 100 203 203 node claude /app/mock-claude.mjs\n202 100 202 203 other unrelated\n203 100 203 203 claude /usr/bin/claude\n900 1 203 203 claude /usr/bin/claude';

describe('POSIX foreground ownership', () => {
  it('requires both live PTY ancestry and current foreground group', () => {
    expect(findForegroundClaude(ps, 100)).toBe(true);
    expect(findForegroundClaude(ps.replace('201 100 203 203', '201 100 201 203').replace('203 100 203 203', '203 100 204 203'), 100)).toBe(false);
    expect(findForegroundClaude('100 1 100 -1 zsh /bin/zsh\n202 100 202 -1 claude claude', 100)).toBe(false);
  });

  it('samples once for concurrent shell requests, then times out safely', async () => {
    const sample = vi.fn(async () => ps);
    const observer = new PosixForegroundObserver(sample);
    const [a, b] = await Promise.all([observer.hasClaude(100), observer.hasClaude(100)]);
    expect([a, b]).toEqual([true, true]);
    expect(sample).toHaveBeenCalledTimes(1);
  });
});
