import { describe, it, expect } from 'vitest';
import { langForPath } from '@renderer/diff/highlight-lang';

describe('langForPath', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/App.tsx', 'typescript'],
    ['lib/x.JS', 'javascript'],
    ['README.md', 'markdown'],
    ['docs/page.MDX', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['a/b/run.sh', 'bash'],
    ['config.toml', 'ini'],
    ['index.html', 'xml'],
    ['main.py', 'python'],
  ])('maps %s to %s', (path, lang) => {
    expect(langForPath(path)).toBe(lang);
  });

  it.each([
    ['file.unknownext'],
    ['Makefile'],
    ['Dockerfile'],
    ['build.dockerfile'],
    ['.gitignore'],
    [''],
  ])('gives plain text for %j', (path) => {
    expect(langForPath(path)).toBe('');
  });

  it('ignores a dotted folder when the file has no extension', () => {
    expect(langForPath('pkg.ts/notes')).toBe('');
  });
});
