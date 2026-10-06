import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SplitDiffView, type SplitDiffViewProps } from '@renderer/components/SplitDiffView';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import type { GitSideContent } from '@shared/ipc-contract';

function render(overrides: Partial<SplitDiffViewProps>): string {
  return renderToStaticMarkup(
    <SplitDiffView
      diff=""
      oldPath="a.ts"
      newPath="a.ts"
      oldSide={{ text: null, skipped: 'absent' }}
      newSide={{ text: null, skipped: 'absent' }}
      {...overrides}
    />,
  );
}

function side(html: string, which: 'old' | 'new'): string {
  const id = which === 'old' ? DIFF_TESTIDS.sideOld : DIFF_TESTIDS.sideNew;
  const match = new RegExp(`<section[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  if (!match?.[1]) throw new Error(`no ${which} side`);
  return match[1];
}

function lineTypes(html: string): string[] {
  return [...html.matchAll(new RegExp(`data-testid="${DIFF_TESTIDS.line}" data-type="(\\w+)"`, 'g'))].map((m) => m[1] ?? '');
}

function gutters(html: string): string[] {
  return [...html.matchAll(new RegExp(`data-testid="${DIFF_TESTIDS.gutter}"[^>]*>(\\d+)<`, 'g'))].map((m) => m[1] ?? '');
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const text = (t: string): GitSideContent => ({ text: t });

const OLD_FILE = ['import x from "y";', 'const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'export { a };', ''].join('\n');
const NEW_FILE = ['import x from "y";', 'const a = 1;', 'const B = 9;', 'export { a };', ''].join('\n');
const THREE_FOR_ONE = [
  'diff --git a/a.ts b/a.ts',
  'index 1..2 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -2,5 +2,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '-const c = 3;',
  '-const d = 4;',
  '+const B = 9;',
  ' export { a };',
  '',
].join('\n');

describe('SplitDiffView', () => {
  it.each([
    ['empty', ''],
    ['binary', 'Binary files a/x and b/x differ\n'],
    ['mode', 'old mode 100644\nnew mode 100755\n'],
    ['rows', THREE_FOR_ONE],
  ])('renders the pane scroll container as the root in the %s state', (_name, diff) => {
    expect(render({ diff })).toMatch(new RegExp(`^<div data-testid="${DIFF_TESTIDS.pane}"`));
  });

  it('shows "(no changes)" for an empty diff and no lines', () => {
    const html = render({ diff: '' });
    expect(html).toContain(`data-testid="${DIFF_TESTIDS.noChanges}"`);
    expect(html).toContain(DIFF_COPY.noChanges);
    expect(lineTypes(html)).toEqual([]);
  });

  it('shows the binary message on both sides and no lines', () => {
    const html = render({ diff: 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n' });
    expect(html).toContain(`data-testid="${DIFF_TESTIDS.binary}"`);
    expect(count(html, DIFF_COPY.binary)).toBe(2);
    expect(lineTypes(html)).toEqual([]);
    expect(html).not.toContain(DIFF_COPY.noChanges);
  });

  it('shows the mode change instead of empty sides', () => {
    const html = render({ diff: 'diff --git a/r.sh b/r.sh\nold mode 100644\nnew mode 100755\n' });
    expect(html).toContain(`data-testid="${DIFF_TESTIDS.mode}"`);
    expect(html).toContain(DIFF_COPY.modeChanged('100644', '100755'));
    expect(html).not.toContain(DIFF_COPY.noChanges);
    expect(html).not.toContain(`data-testid="${DIFF_TESTIDS.sideOld}"`);
  });

  it('aligns a 3-for-1 change with fillers opposite the surplus removed lines', () => {
    const html = render({ diff: THREE_FOR_ONE, oldSide: text(OLD_FILE), newSide: text(NEW_FILE) });
    expect(lineTypes(side(html, 'old'))).toEqual(['context', 'removed', 'removed', 'removed', 'context']);
    expect(lineTypes(side(html, 'new'))).toEqual(['context', 'added', 'filler', 'filler', 'context']);
  });

  it('numbers each side from its hunk start and gives fillers no number', () => {
    const html = render({ diff: THREE_FOR_ONE, oldSide: text(OLD_FILE), newSide: text(NEW_FILE) });
    expect(gutters(side(html, 'old'))).toEqual(['2', '3', '4', '5', '6']);
    expect(gutters(side(html, 'new'))).toEqual(['2', '3', '4']);
    expect(side(html, 'new')).toMatch(new RegExp(`data-type="filler"[^>]*></div>`));
  });

  it('never shows the file header or raw @@ text', () => {
    const html = render({ diff: THREE_FOR_ONE, oldSide: text(OLD_FILE), newSide: text(NEW_FILE) });
    expect(html).not.toContain('diff --git');
    expect(html).not.toContain('@@');
    expect(html).not.toContain('+++');
  });

  it('puts one separator per side between hunks, announced once', () => {
    const diff = '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n';
    const html = render({ diff, oldPath: 'x.unknownext', newPath: 'x.unknownext' });
    for (const which of ['old', 'new'] as const) expect(count(side(html, which), `data-testid="${DIFF_TESTIDS.separator}"`)).toBe(1);
    expect(side(html, 'old')).not.toMatch(/data-testid="diff-separator" aria-hidden="true"/);
    expect(side(html, 'new')).toMatch(/data-testid="diff-separator" aria-hidden="true"/);
  });

  it('highlights both sides with their own language when content matches', () => {
    const oldText = 'const a = 1;\n';
    const newText = 'const a = 2;\n';
    const diff = '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
    const html = render({ diff, oldPath: 'old.ts', newPath: 'new.js', oldSide: text(oldText), newSide: text(newText) });
    expect(side(html, 'old')).toContain('class="hljs language-typescript');
    expect(side(html, 'new')).toContain('class="hljs language-javascript');
    expect(side(html, 'old')).toContain('<span class="hljs-keyword">const</span>');
    expect(side(html, 'new')).toContain('<span class="hljs-keyword">const</span>');
  });

  it('colours hunk lines inside a block comment that opens above the hunk', () => {
    const file = (last: string) => ['/* header', ' * one', ' * two', ' * three', ` * ${last}`, ' */', 'let z = 0;', ''].join('\n');
    const diff = '@@ -4,2 +4,2 @@\n  * three\n- * four\n+ * FOUR\n';
    const html = render({ diff, oldSide: text(file('four')), newSide: text(file('FOUR')) });
    for (const which of ['old', 'new'] as const) {
      expect(side(html, which)).toContain('<span class="hljs-comment"> * three</span>');
      expect(side(html, which)).toMatch(/<span class="hljs-comment"> \* (four|FOUR)<\/span>/);
    }
  });

  it('shows only the side whose content does not match the diff as plain text, with no note', () => {
    const diff = '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
    const html = render({ diff, oldSide: text('const a = 1;\n'), newSide: text('const a = 3;\n') });
    expect(side(html, 'old')).toContain('hljs-keyword');
    expect(side(html, 'new')).not.toContain('hljs-');
    expect(side(html, 'new')).toContain('class="hljs language-plaintext');
    expect(side(html, 'new')).toContain('const a = 2;');
    expect(html).not.toContain(DIFF_COPY.highlightOff);
  });

  it('turns highlighting off on both sides with a note when either side is too large', () => {
    const diff = '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
    const html = render({ diff, oldSide: text('const a = 1;\n'), newSide: { text: null, skipped: 'too-large' } });
    expect(html).toContain(`data-testid="${DIFF_TESTIDS.highlightOff}"`);
    expect(html).toContain(DIFF_COPY.highlightOff);
    expect(html).not.toContain('hljs-');
    expect(lineTypes(html)).toEqual(['removed', 'added']);
    expect(gutters(html)).toEqual(['1', '1']);
  });

  it.each(['unavailable', 'binary', 'absent'] as const)('shows no note when a side is skipped as %s', (skipped) => {
    const diff = '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
    const html = render({ diff, oldSide: text('const a = 1;\n'), newSide: { text: null, skipped } });
    expect(html).not.toContain(DIFF_COPY.highlightOff);
    expect(side(html, 'old')).toContain('hljs-keyword');
    expect(side(html, 'new')).not.toContain('hljs-');
  });

  it('shows an unknown extension as plain text', () => {
    const diff = '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
    const html = render({ diff, oldPath: 'x.unknownext', newPath: 'x.unknownext', oldSide: text('const a = 1;\n'), newSide: text('const a = 2;\n') });
    expect(html).not.toContain('hljs-');
    expect(html).toContain('const a = 1;');
  });

  it.each([
    ['highlighted html', 'page.html'],
    ['highlighted ts', 'page.ts'],
    ['plain', 'page.unknownext'],
  ])('renders hostile content literally in %s mode', (_mode, path) => {
    const oldLine = '<img src=x onerror=alert(1)>';
    const newLine = '</span><script>alert(2)</script> &lt;';
    const diff = `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-${oldLine}\n+${newLine}\n`;
    const html = render({ diff, oldPath: path, newPath: path, oldSide: text(`${oldLine}\n`), newSide: text(`${newLine}\n`) });
    expect(html).not.toMatch(/<img|<script|<\/span><script/i);
    expect(html.replace(/<span class="[^"]*">|<\/span>/g, '')).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&amp;lt;');
  });

  it('renders a hostile file name as text only', () => {
    const path = '"><img src=x onerror=alert(1)>.ts';
    const html = render({ diff: '@@ -1 +1 @@\n-a\n+b\n', oldPath: path, newPath: path, oldSide: text('a\n'), newSide: text('b\n') });
    expect(html).not.toMatch(/<img/i);
  });
});
