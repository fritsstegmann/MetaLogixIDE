import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAllTasks, discoverTasks } from '@main/domain/tasks';
import type { MiseLister, MiseListResult } from '@main/domain/mise-cli';

const MAKEFILE = '.PHONY: build\nbuild: deps\n\techo b\nVAR := x\ntest:\n\techo t\nbuild:\n';
const COMPOSE = 'services:\n  web:\n    image: x\n  db:\n    image: y\nvolumes:\n  data:\n';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tasks-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

function fullProject(extra: Record<string, string> = {}): string {
  return project({
    'package.json': JSON.stringify({ scripts: { dev: 'vite', long: 'x'.repeat(100) } }),
    'pnpm-lock.yaml': '',
    Makefile: MAKEFILE,
    'compose.yaml': COMPOSE,
    ...extra,
  });
}

const lister = (result: MiseListResult) => vi.fn<MiseLister>(async () => result);
const MISE_OK = JSON.stringify([{ name: 'build', description: 'Build it', hide: false, global: false }, { name: 'hello' }]);

describe('discoverTasks (npm, make, compose — pinned before mise lands)', () => {
  it('lists npm scripts with the lockfile-picked pm, then make targets, then compose services', () => {
    expect(discoverTasks(fullProject())).toEqual([
      { id: 'npm:dev', source: 'npm', name: 'dev', command: ['pnpm', 'run', 'dev'], description: 'vite' },
      { id: 'npm:long', source: 'npm', name: 'long', command: ['pnpm', 'run', 'long'], description: `${'x'.repeat(80)}…` },
      { id: 'make:build', source: 'make', name: 'build', command: ['make', 'build'] },
      { id: 'make:test', source: 'make', name: 'test', command: ['make', 'test'] },
      { id: 'compose:web', source: 'compose', name: 'up web', command: ['docker', 'compose', 'up', 'web'], description: 'compose.yaml · service' },
      { id: 'compose:db', source: 'compose', name: 'up db', command: ['docker', 'compose', 'up', 'db'], description: 'compose.yaml · service' },
    ]);
  });

  it('never lists mise tasks itself', () => {
    expect(discoverTasks(fullProject({ 'mise.toml': '[tasks.a]\nrun = "echo"\n' })).some((t) => t.source === 'mise')).toBe(false);
  });

  it('keeps other sources when package.json is malformed', () => {
    expect(discoverTasks(project({ 'package.json': '{', Makefile: 'a:\n' })).map((t) => t.id)).toEqual(['make:a']);
  });
});

describe('discoverAllTasks', () => {
  const ENV = { PATH: '/bin', API_URL: 'x' };

  it('returns npm, make and compose exactly as discoverTasks does, followed by the mise tasks (AC1, AC7)', async () => {
    const root = fullProject({ 'mise.toml': '' });
    const list = lister({ kind: 'ok', stdout: MISE_OK });
    const r = await discoverAllTasks(root, { env: ENV, listMise: list });
    expect(r.tasks.slice(0, 6)).toEqual(discoverTasks(root));
    expect(r.tasks.slice(6)).toEqual([
      { id: 'mise:build', source: 'mise', name: 'build', command: ['mise', 'run', 'build'], description: 'Build it' },
      { id: 'mise:hello', source: 'mise', name: 'hello', command: ['mise', 'run', 'hello'] },
    ]);
    expect(r.notices).toEqual([]);
  });

  it('passes the project root and the given env to the mise lister (AC6)', async () => {
    const root = fullProject({ 'mise.toml': '' });
    const list = lister({ kind: 'ok', stdout: '[]' });
    await discoverAllTasks(root, { env: ENV, listMise: list });
    expect(list).toHaveBeenCalledWith(root, ENV);
  });

  it('starts no mise process and returns no notice for a project without a mise marker (AC4, AC7)', async () => {
    const root = fullProject();
    const list = lister({ kind: 'ok', stdout: MISE_OK });
    expect(await discoverAllTasks(root, { env: ENV, listMise: list })).toEqual({ tasks: discoverTasks(root), notices: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it.each<[string, MiseListResult, object]>([
    ['not-found', { kind: 'not-found' }, { source: 'mise', kind: 'not-found' }],
    ['untrusted', { kind: 'failed', stderr: 'mise ERROR Config files in ~/p/mise.toml are not trusted.' }, { source: 'mise', kind: 'untrusted' }],
    ['failed', { kind: 'failed', stderr: 'mise ERROR boom' }, { source: 'mise', kind: 'failed', detail: 'boom' }],
    ['timed-out', { kind: 'timed-out' }, { source: 'mise', kind: 'timed-out' }],
    ['unexpected', { kind: 'ok', stdout: '{}' }, { source: 'mise', kind: 'unexpected' }],
  ])('keeps the other sources and adds one %s notice when listing fails (AC10–AC13)', async (_kind, result, notice) => {
    const root = fullProject({ 'mise.toml': '' });
    const r = await discoverAllTasks(root, { env: ENV, listMise: lister(result) });
    expect(r).toEqual({ tasks: discoverTasks(root), notices: [notice] });
  });

  it('is asynchronous: it returns a promise before the lister resolves (AC14)', async () => {
    const root = fullProject({ 'mise.toml': '' });
    let release: (r: MiseListResult) => void = () => {};
    const list = vi.fn<MiseLister>(() => new Promise((res) => { release = res; }));
    let done = false;
    const p = discoverAllTasks(root, { env: ENV, listMise: list }).then((r) => { done = true; return r; });
    expect(p).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(done).toBe(false);
    release({ kind: 'ok', stdout: '[]' });
    expect((await p).tasks).toHaveLength(6);
  });
});
