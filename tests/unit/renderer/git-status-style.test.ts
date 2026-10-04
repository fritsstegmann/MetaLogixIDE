import { describe, it, expect } from 'vitest';
import type { GitFileStatus } from '@shared/ipc-contract';
import { gitStatusTextClass } from '@renderer/git-status-style';

describe('gitStatusTextClass', () => {
  it.each<[GitFileStatus, string]>([
    ['M', 'text-amber-400'],
    ['A', 'text-emerald-400'],
    ['D', 'text-rose-400'],
    ['?', 'text-sky-400'],
    ['R', 'text-[--text-muted]'],
    ['U', 'text-[--text-muted]'],
    ['!', 'text-[--text-muted]'],
  ])('gives %s the Git panel colour %s', (status, cls) => {
    expect(gitStatusTextClass(status)).toBe(cls);
  });
});
