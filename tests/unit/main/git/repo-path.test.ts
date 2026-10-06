import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toRepoRelativePath, assertWorktreeContained, PathRejectedError } from '@main/git/repo-path';

/** A project folder next to a sibling `<project>-evil` folder and an outside folder, all on disk. */
function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a1-repopath-')));
  const root = join(base, 'proj');
  const evil = join(base, 'proj-evil');
  const outside = join(base, 'outside');
  for (const d of [root, evil, outside, join(root, 'dir', 'sub'), join(root, 'd')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(evil, 'x'), 'evil');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  writeFileSync(join(root, 'dir', 'sub', 'u1.txt'), 'u1');
  symlinkSync(outside, join(root, 'd', 'up'));
  return { base, root, evil, outside };
}

describe('toRepoRelativePath', () => {
  const { root } = layout();

  it.each([
    ['empty', ''],
    ['absolute', '/etc/passwd'],
    ['parent escape', '../x'],
    ['nested escape', 'a/../../x'],
    ['NUL byte', 'a\0b'],
    ['sibling folder sharing the project name prefix', '../proj-evil/x'],
    ['the root itself', '.'],
    ['the root via a detour', 'a/..'],
  ])('rejects %s', (_label, input) => {
    expect(() => toRepoRelativePath(root, input)).toThrow(PathRejectedError);
  });

  it('rejects an absolute path even when it points inside the project', () => {
    expect(() => toRepoRelativePath(root, join(root, 'dir', 'sub', 'u1.txt'))).toThrow(PathRejectedError);
  });

  it('rejects a root-prefixed absolute sibling path', () => {
    expect(() => toRepoRelativePath(root, `${root}-evil/x`)).toThrow(PathRejectedError);
  });

  it.each([
    ['dir/sub/u1.txt', 'dir/sub/u1.txt'],
    ['new name é.ts', 'new name é.ts'],
    ['a/../b.ts', 'b.ts'],
    ['./c.ts', 'c.ts'],
  ])('accepts %j as %j', (input, expected) => {
    expect(toRepoRelativePath(root, input)).toBe(expected);
  });

  it('accepts a root given with a trailing separator', () => {
    expect(toRepoRelativePath(`${root}/`, 'dir/sub/u1.txt')).toBe('dir/sub/u1.txt');
  });

  it('rejects a non-string input', () => {
    expect(() => toRepoRelativePath(root, 42 as unknown as string)).toThrow(PathRejectedError);
  });
});

describe('assertWorktreeContained', () => {
  const { root } = layout();

  it('rejects a path through a directory symlink that leads outside the project', () => {
    expect(() => assertWorktreeContained(root, 'd/up/secret.txt')).toThrow(PathRejectedError);
  });

  it('rejects a missing file under a directory symlink that leads outside', () => {
    expect(() => assertWorktreeContained(root, 'd/up/missing/deeper.txt')).toThrow(PathRejectedError);
  });

  it('accepts a normal nested path and a top-level path', () => {
    expect(() => assertWorktreeContained(root, 'dir/sub/u1.txt')).not.toThrow();
    expect(() => assertWorktreeContained(root, 'top.txt')).not.toThrow();
  });

  it('accepts a path whose folders no longer exist inside the project', () => {
    expect(() => assertWorktreeContained(root, 'gone/away/file.txt')).not.toThrow();
  });

  it('accepts a project root that is itself reached through a symlink', () => {
    const { base, root: realRoot } = layout();
    const alias = join(base, 'alias');
    symlinkSync(realRoot, alias);
    expect(() => assertWorktreeContained(alias, 'dir/sub/u1.txt')).not.toThrow();
  });

  it('uses the injected realpath and rejects when it resolves the parent outside', () => {
    const realpath = (p: string) => (p.endsWith('/inner') ? '/elsewhere/inner' : p);
    expect(() => assertWorktreeContained('/r', 'inner/f.txt', realpath)).toThrow(PathRejectedError);
  });

  it('propagates a realpath failure other than a missing path', () => {
    const realpath = (p: string) => {
      if (p === '/r') return p;
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(() => assertWorktreeContained('/r', 'inner/f.txt', realpath)).toThrow('EACCES');
  });
});
