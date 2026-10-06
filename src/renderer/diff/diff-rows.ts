/**
 * Aligns parsed hunks into side-by-side rows (spec AC14, AC35, AC36) and checks a side's full file content against
 * them (AC38). Context lines share a row; in each change block the first min(k, m) removed and added lines share rows
 * and the rest sit opposite a null cell (a filler). Line numbers come from the hunk starts. A separator goes between
 * hunks, and before the first hunk when it starts after line 1.
 */
import type { DiffLineType, Hunk } from './unified-diff';

export interface Cell {
  lineNo: number;
  text: string;
  type: DiffLineType;
}

export type Row = { kind: 'separator' } | { kind: 'line'; left: Cell | null; right: Cell | null };

function flushBlock(removed: Cell[], added: Cell[], rows: Row[]): void {
  const n = Math.max(removed.length, added.length);
  for (let i = 0; i < n; i++) rows.push({ kind: 'line', left: removed[i] ?? null, right: added[i] ?? null });
  removed.length = 0;
  added.length = 0;
}

function alignHunk(hunk: Hunk, rows: Row[]): void {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const removed: Cell[] = [];
  const added: Cell[] = [];
  for (const { type, text } of hunk.lines) {
    if (type === 'removed') removed.push({ lineNo: oldNo++, text, type });
    else if (type === 'added') added.push({ lineNo: newNo++, text, type });
    else {
      flushBlock(removed, added, rows);
      rows.push({ kind: 'line', left: { lineNo: oldNo++, text, type }, right: { lineNo: newNo++, text, type } });
    }
  }
  flushBlock(removed, added, rows);
}

/** Turns `hunks` into aligned rows: `line` rows with a left (old) and right (new) cell, null for a filler, plus separators. */
export function alignHunks(hunks: Hunk[]): Row[] {
  const rows: Row[] = [];
  hunks.forEach((hunk, i) => {
    if (i > 0 || Math.max(hunk.oldStart, hunk.newStart) > 1) rows.push({ kind: 'separator' });
    alignHunk(hunk, rows);
  });
  return rows;
}

/** True when every cell on `side` equals the line with its number in `content`, split on `\n` only so `\r` must match too. */
export function sideMatchesContent(rows: Row[], side: 'left' | 'right', content: string): boolean {
  const lines = content.split('\n');
  return rows.every((row) => {
    if (row.kind === 'separator') return true;
    const cell = row[side];
    return cell === null || lines[cell.lineNo - 1] === cell.text;
  });
}
