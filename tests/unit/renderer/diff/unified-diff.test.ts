import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, type Hunk, type ParsedDiff } from '@renderer/diff/unified-diff';

function hunkAt(parsed: ParsedDiff, i: number): Hunk {
  const hunk = parsed.hunks[i];
  if (!hunk) throw new Error(`no hunk at ${i}`);
  return hunk;
}

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -120,4 +124,5 @@ function outer() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('skips the file header and keeps no raw @@ text', () => {
    const parsed = parseUnifiedDiff(MODIFIED);
    const texts = parsed.hunks.flatMap((h) => h.lines.map((l) => l.text));
    expect(texts).toEqual(['const a = 1;', 'const b = 2;', 'const b = 3;', 'const c = 4;', 'const d = 5;', 'const e = 6;']);
    expect(texts.some((t) => t.includes('@@') || t.startsWith('diff --git') || t.startsWith('index '))).toBe(false);
    expect(parsed.binary).toBe(false);
    expect(parsed.oldMode).toBeUndefined();
  });

  it('parses hunk starts and line types', () => {
    const hunk = hunkAt(parseUnifiedDiff(MODIFIED), 0);
    expect(hunk.oldStart).toBe(120);
    expect(hunk.newStart).toBe(124);
    expect(hunk.lines.map((l) => l.type)).toEqual(['context', 'removed', 'added', 'added', 'context', 'context']);
  });

  it('treats an omitted count as 1 and a zero-line side as empty', () => {
    const parsed = parseUnifiedDiff('@@ -3 +3 @@\n-x\n+y\n@@ -0,0 +1,2 @@\n+p\n+q\n');
    expect(parsed.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([[3, 3], [0, 1]]);
    expect(hunkAt(parsed, 0).lines).toEqual([{ type: 'removed', text: 'x' }, { type: 'added', text: 'y' }]);
    expect(hunkAt(parsed, 1).lines.map((l) => l.text)).toEqual(['p', 'q']);
  });

  it('keeps reading the side whose count was omitted', () => {
    const parsed = parseUnifiedDiff('@@ -3,2 +3 @@\n-a\n-b\n+c\n');
    expect(hunkAt(parsed, 0).lines.map((l) => `${l.type}:${l.text}`)).toEqual(['removed:a', 'removed:b', 'added:c']);
    const flipped = parseUnifiedDiff('@@ -3 +3,2 @@\n+a\n+b\n-c\n');
    expect(hunkAt(flipped, 0).lines.map((l) => `${l.type}:${l.text}`)).toEqual(['added:a', 'added:b', 'removed:c']);
  });

  it('reads hunk bodies by count, so content that looks like a header is kept', () => {
    const parsed = parseUnifiedDiff('@@ -1,2 +1,2 @@\n--- a/x\n-@@ -9 +9 @@\n+++ b/y\n+diff --git a b\n');
    expect(parsed.hunks).toHaveLength(1);
    expect(hunkAt(parsed, 0).lines).toEqual([
      { type: 'removed', text: '-- a/x' },
      { type: 'removed', text: '@@ -9 +9 @@' },
      { type: 'added', text: '++ b/y' },
      { type: 'added', text: 'diff --git a b' },
    ]);
  });

  it('marks the previous line for "\\ No newline at end of file" and adds no row', () => {
    const parsed = parseUnifiedDiff('@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n');
    expect(hunkAt(parsed, 0).lines).toEqual([
      { type: 'context', text: 'a' },
      { type: 'removed', text: 'b', noNewline: true },
      { type: 'added', text: 'b' },
      { type: 'added', text: 'c', noNewline: true },
    ]);
  });

  it('flags a binary diff and returns no hunks', () => {
    const parsed = parseUnifiedDiff('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n');
    expect(parsed).toEqual({ binary: true, hunks: [] });
  });

  it('flags a GIT binary patch as binary', () => {
    expect(parseUnifiedDiff('diff --git a/x b/x\nGIT binary patch\nliteral 3\n').binary).toBe(true);
  });

  it('reads a mode-only change', () => {
    const parsed = parseUnifiedDiff('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n');
    expect(parsed).toEqual({ binary: false, oldMode: '100644', newMode: '100755', hunks: [] });
  });

  it('does not treat new file mode or deleted file mode as a mode change', () => {
    const parsed = parseUnifiedDiff('diff --git a/n b/n\nnew file mode 100644\nindex 0000000..e69de29\n');
    expect(parsed).toEqual({ binary: false, hunks: [] });
    expect(parseUnifiedDiff('diff --git a/n b/n\ndeleted file mode 100755\n').oldMode).toBeUndefined();
  });

  it('parses a rename header followed by hunks', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/old.js b/new.ts',
      'similarity index 90%',
      'rename from old.js',
      'rename to new.ts',
      'index 1..2 100644',
      '--- a/old.js',
      '+++ b/new.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-was',
      '+now',
      '',
    ].join('\n'));
    expect(parsed.hunks).toHaveLength(1);
    expect(hunkAt(parsed, 0).lines.map((l) => `${l.type}:${l.text}`)).toEqual(['context:keep', 'removed:was', 'added:now']);
  });

  it('returns no hunks for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual({ binary: false, hunks: [] });
  });

  it('keeps a trailing \\r on CRLF lines', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-a\r\n+b\r\n');
    expect(hunkAt(parsed, 0).lines.map((l) => l.text)).toEqual(['a\r', 'b\r']);
  });

  it('keeps an empty context line inside a hunk', () => {
    const parsed = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n');
    expect(hunkAt(parsed, 0).lines.map((l) => `${l.type}:${l.text}`)).toEqual(['context:a', 'context:', 'removed:b', 'added:c']);
  });
});
