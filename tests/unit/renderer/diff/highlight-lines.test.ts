import { describe, it, expect } from 'vitest';
import { highlightToLines } from '@renderer/diff/highlight-lines';

const ALLOWED = /^(?:<span class="[A-Za-z0-9_ -]+">|<\/span>|[^<>])*$/;

function textOf(html: string): string {
  return html
    .replace(/<span class="[^"]*">|<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function depthProfile(html: string): { balanced: boolean; minDepth: number } {
  let depth = 0;
  let minDepth = 0;
  for (const m of html.matchAll(/<span class="[^"]*">|<\/span>/g)) {
    depth += m[0] === '</span>' ? -1 : 1;
    minDepth = Math.min(minDepth, depth);
  }
  return { balanced: depth === 0, minDepth };
}

function expectWellFormed(lines: string[], text: string): void {
  const source = text.split('\n');
  expect(lines).toHaveLength(source.length);
  lines.forEach((line, i) => {
    expect(line).toMatch(ALLOWED);
    expect(depthProfile(line)).toEqual({ balanced: true, minDepth: 0 });
    expect(textOf(line)).toBe(source[i]);
  });
}

const HOSTILE = [
  'const a = "<img src=x onerror=alert(1)>";',
  "const b = '</span><script>alert(2)</script>';",
  '// &lt; stays &amp; literal & "quoted" \'single\'',
  '<img src=x onerror=alert(3)>',
  '</span><script>alert(4)</script>',
].join('\n');

describe('highlightToLines', () => {
  it('wraps every line of a multi-line block comment in hljs-comment', () => {
    const text = '/* one\n   two\n   three */\nconst x = 1;';
    const lines = highlightToLines(text, 'typescript');
    expectWellFormed(lines, text);
    for (const line of lines.slice(0, 3)) expect(line).toMatch(/^<span class="hljs-comment">.*<\/span>$/);
    expect(lines[3]).not.toContain('hljs-comment');
    expect(lines[3]).toContain('hljs-keyword');
  });

  it('wraps every line of a multi-line template string in hljs-string', () => {
    const text = 'const s = `one\ntwo\nthree`;\nlet y = 2;';
    const lines = highlightToLines(text, 'typescript');
    expectWellFormed(lines, text);
    expect(lines[1]).toBe('<span class="hljs-string">two</span>');
    expect(lines[2]).toMatch(/^<span class="hljs-string">three`<\/span>;$/);
    expect(lines[3]).not.toContain('hljs-string');
  });

  it('reopens nested spans on the next line', () => {
    const text = 'const s = `a ${\nb\n} c`;';
    const lines = highlightToLines(text, 'typescript');
    expectWellFormed(lines, text);
    expect(lines[1]).toMatch(/^<span class="hljs-string"><span class="hljs-subst">b<\/span><\/span>$/);
  });

  it('gives one entry per line, including a trailing empty line and CRLF lines', () => {
    const text = 'a = 1\r\nb = 2\r\n';
    const lines = highlightToLines(text, 'python');
    expectWellFormed(lines, text);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
  });

  it.each(['typescript', 'xml', ''])('escapes hostile content in %j mode and keeps it literal', (lang) => {
    const lines = highlightToLines(HOSTILE, lang);
    expectWellFormed(lines, HOSTILE);
    const html = lines.join('\n');
    expect(html).not.toMatch(/<(?!\/?span\b)/);
    expect(html).toMatch(/&lt;(<span class="[^"]*">)*img/);
    expect(html).toContain('&amp;lt;');
    expect(lines.map(textOf).join('\n')).toBe(HOSTILE);
  });

  it('gives escaped plain text for an unknown language', () => {
    expect(highlightToLines('<b>&\n"x"', 'nosuchlang')).toEqual(['&lt;b&gt;&amp;', '&quot;x&quot;']);
  });

  it('gives escaped plain text when the emitter output fails the allow-list', () => {
    const forged = () => '<span class="ok" onclick="x()">a</span>\n<img src=x onerror=y>';
    expect(highlightToLines('a\n<img>', 'typescript', forged)).toEqual(['a', '&lt;img&gt;']);
  });

  it('gives escaped plain text when only one emitted line is outside the allow-list', () => {
    const forged = () => '<span class="hljs-keyword">a</span>\n<b>c</b>';
    expect(highlightToLines('a\n<c>', 'typescript', forged)).toEqual(['a', '&lt;c&gt;']);
  });

  it('gives escaped plain text when an emitted span carries attributes beyond class', () => {
    const forged = () => '<span class="hljs-keyword" onmouseover="x()">a</span>';
    expect(highlightToLines('a', 'typescript', forged)).toEqual(['a']);
  });

  it('gives escaped plain text when an emitted line holds an unterminated tag', () => {
    const forged = () => 'ok\n<img src=x onerror=alert(1) //';
    expect(highlightToLines('ok\nb', 'typescript', forged)).toEqual(['ok', 'b']);
  });

  it('gives escaped plain text when the emitter line count does not match the text', () => {
    const forged = () => 'only one line';
    expect(highlightToLines('x\n&', 'typescript', forged)).toEqual(['x', '&amp;']);
  });

  it('gives escaped plain text when the emitter throws', () => {
    const throwing = () => {
      throw new Error('boom');
    };
    let lines: string[] = [];
    expect(() => {
      lines = highlightToLines("'q'", 'typescript', throwing);
    }).not.toThrow();
    expect(lines).toEqual(['&#39;q&#39;']);
  });
});
