import { describe, it, expect } from 'vitest';
import { alignHunks, sideMatchesContent, type Row } from '@renderer/diff/diff-rows';
import type { Hunk } from '@renderer/diff/unified-diff';

function hunk(oldStart: number, newStart: number, spec: string): Hunk {
  const types = { ' ': 'context', '-': 'removed', '+': 'added' } as const;
  return {
    oldStart,
    newStart,
    lines: spec.split('|').map((s) => ({ type: types[s.charAt(0) as ' ' | '-' | '+'], text: s.slice(1) })),
  };
}

function show(rows: Row[]): string[] {
  return rows.map((r) => {
    if (r.kind === 'separator') return '---';
    const cell = (c: typeof r.left) => (c ? `${c.lineNo}${c.type.charAt(0)}:${c.text}` : '_');
    return `${cell(r.left)} | ${cell(r.right)}`;
  });
}

describe('alignHunks', () => {
  it('pairs context lines on the same row with their own line numbers', () => {
    expect(show(alignHunks([hunk(120, 124, ' a| b')]))).toEqual(['---', '120c:a | 124c:a', '121c:b | 125c:b']);
  });

  it('pairs min(k, m) of a change block and puts the rest opposite fillers (k=3, m=1)', () => {
    expect(show(alignHunks([hunk(1, 1, ' x|-r1|-r2|-r3|+a1| y')]))).toEqual([
      '1c:x | 1c:x',
      '2r:r1 | 2a:a1',
      '3r:r2 | _',
      '4r:r3 | _',
      '5c:y | 3c:y',
    ]);
  });

  it('puts surplus added lines opposite fillers (k=1, m=3)', () => {
    expect(show(alignHunks([hunk(1, 1, '-r|+a|+b|+c')]))).toEqual(['1r:r | 1a:a', '_ | 2a:b', '_ | 3a:c']);
  });

  it('handles a pure insertion (k=0) and a pure deletion (m=0)', () => {
    expect(show(alignHunks([hunk(1, 1, ' x|+a|+b| y')]))).toEqual(['1c:x | 1c:x', '_ | 2a:a', '_ | 3a:b', '2c:y | 4c:y']);
    expect(show(alignHunks([hunk(1, 1, ' x|-a| y')]))).toEqual(['1c:x | 1c:x', '2r:a | _', '3c:y | 2c:y']);
  });

  it('closes a change block at each context line', () => {
    expect(show(alignHunks([hunk(1, 1, '-a| c|+b')]))).toEqual(['1r:a | _', '2c:c | 1c:c', '_ | 2a:b']);
  });

  it('puts a separator between hunks but never after the last', () => {
    const rows = show(alignHunks([hunk(1, 1, ' a|-b|+B'), hunk(40, 40, ' z')]));
    expect(rows).toEqual(['1c:a | 1c:a', '2r:b | 2a:B', '---', '40c:z | 40c:z']);
  });

  it('puts a separator before a first hunk that starts after line 1, on either side', () => {
    expect(show(alignHunks([hunk(2, 2, ' a')]))[0]).toBe('---');
    expect(show(alignHunks([hunk(1, 3, ' a')]))[0]).toBe('---');
    expect(show(alignHunks([hunk(5, 0, '-a')]))[0]).toBe('---');
  });

  it('aligns an all-added (untracked) diff with no left cells and no separator', () => {
    expect(show(alignHunks([hunk(0, 1, '+a|+b')]))).toEqual(['_ | 1a:a', '_ | 2a:b']);
  });

  it('aligns an all-removed (deleted) diff with no right cells and no separator', () => {
    expect(show(alignHunks([hunk(1, 0, '-a|-b')]))).toEqual(['1r:a | _', '2r:b | _']);
  });

  it('returns no rows for no hunks', () => {
    expect(alignHunks([])).toEqual([]);
  });
});

describe('sideMatchesContent', () => {
  const rows = alignHunks([hunk(2, 2, ' b|-c|+C| d')]);

  it('accepts content whose lines equal every cell on that side', () => {
    expect(sideMatchesContent(rows, 'left', 'a\nb\nc\nd\n')).toBe(true);
    expect(sideMatchesContent(rows, 'right', 'a\nb\nC\nd')).toBe(true);
  });

  it('rejects content that differs from any cell on that side', () => {
    expect(sideMatchesContent(rows, 'left', 'a\nb\nC\nd\n')).toBe(false);
    expect(sideMatchesContent(rows, 'right', 'a\nb\nC\nD\n')).toBe(false);
  });

  it('rejects content that is too short for the cells', () => {
    expect(sideMatchesContent(rows, 'right', 'a\nb')).toBe(false);
  });

  it('rejects content whose line endings differ from the diff', () => {
    expect(sideMatchesContent(rows, 'left', 'a\r\nb\r\nc\r\nd\r\n')).toBe(false);
  });

  it('accepts any content for a side with no cells', () => {
    expect(sideMatchesContent(alignHunks([hunk(0, 1, '+a')]), 'left', '')).toBe(true);
  });
});
