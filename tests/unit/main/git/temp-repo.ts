/**
 * Temp git repositories for the git unit tests. Every helper runs git with no global or system
 * config and a fixed identity; `stubGitEnv` applies the same to `process.env` so code under test
 * that spawns git inherits it. Each repo is `<base>/proj`, so `<base>` is free for outside files.
 */
import { vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
} as const;

/** Stub `GIT_ENV` into `process.env`; pair with `vi.unstubAllEnvs()` in `afterEach`. */
export function stubGitEnv(): void {
  for (const [k, v] of Object.entries(GIT_ENV)) vi.stubEnv(k, v);
}

/** Run git in `cwd` with `GIT_ENV`; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
}

/** A fresh, empty project folder `<base>/proj` (no git yet), with real paths. */
export function tempProject(prefix = 'a1-git-'): { root: string; base: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const root = join(base, 'proj');
  mkdirSync(root);
  return { root, base };
}

/** A fresh repository on branch `main` at `<base>/proj`. */
export function initRepo(prefix?: string): { root: string; base: string } {
  const dirs = tempProject(prefix);
  git(dirs.root, 'init', '-q', '-b', 'main');
  return dirs;
}

/** Stage everything and commit. */
export function commitAll(root: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c');
}

/** An executable script in `base` that creates `marker` when run, so a test can prove whether git ran it. */
export function markerScript(base: string, name: string): { script: string; marker: string } {
  const marker = join(base, `${name}.marker`);
  const script = join(base, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\nexit 0\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

/** Leave `f.ts` in a `UU` merge conflict (HEAD "theirs", other branch "ours"). */
export function makeConflict(root: string): void {
  writeFileSync(join(root, 'f.ts'), 'base\n');
  commitAll(root);
  git(root, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(root, 'f.ts'), 'ours\n');
  commitAll(root);
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'f.ts'), 'theirs\n');
  commitAll(root);
  spawnSync('git', ['merge', 'other'], { cwd: root, env: { ...process.env, ...GIT_ENV } });
}
