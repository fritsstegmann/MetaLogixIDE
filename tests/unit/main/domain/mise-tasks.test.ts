import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MISE_MARKERS, discoverMiseTasks, hasMiseMarker, miseFailureDetail, parseMiseTasks } from '@main/domain/mise-tasks';
import type { MiseLister, MiseListResult } from '@main/domain/mise-cli';

const json = (v: unknown): string => JSON.stringify(v);
const task = (name: string, extra: Record<string, unknown> = {}) => ({
  name, aliases: [], description: '', source: '/p/mise.toml', hide: false, global: false, run: ['echo'], ...extra,
});

function lister(result: MiseListResult) {
  return vi.fn<MiseLister>(async () => result);
}

function projectWith(marker?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mise-tasks-'));
  if (!marker) return root;
  if (marker.endsWith('/')) {
    mkdirSync(join(root, marker), { recursive: true });
  } else {
    mkdirSync(join(root, marker, '..'), { recursive: true });
    writeFileSync(join(root, marker), '[tasks.a]\nrun = "echo"\n');
  }
  return root;
}

describe('parseMiseTasks', () => {
  it('maps each task to id mise:<name>, source mise, and argv mise run <name>, keeping mise order (AC1, AC8)', () => {
    expect(parseMiseTasks(json([task('build'), task('a:b'), task('test')]))).toEqual([
      { id: 'mise:build', source: 'mise', name: 'build', command: ['mise', 'run', 'build'] },
      { id: 'mise:a:b', source: 'mise', name: 'a:b', command: ['mise', 'run', 'a:b'] },
      { id: 'mise:test', source: 'mise', name: 'test', command: ['mise', 'run', 'test'] },
    ]);
  });

  it('returns an empty list for an empty array, so a tools-only config shows nothing', () => {
    expect(parseMiseTasks('[]\n')).toEqual([]);
  });

  it('sets a description only when mise gives a non-empty string (AC2)', () => {
    const tasks = parseMiseTasks(json([
      task('a', { description: 'Build it' }),
      task('b', { description: '' }),
      task('c', { description: undefined }),
      task('d', { description: 42 }),
      task('e', { description: null }),
    ]))!;
    expect(tasks[0]!.description).toBe('Build it');
    for (const t of tasks.slice(1)) expect(t).not.toHaveProperty('description');
  });

  it('drops hidden and global tasks (AC3)', () => {
    const tasks = parseMiseTasks(json([task('shown'), task('hidden', { hide: true }), task('glob', { global: true })]));
    expect(tasks!.map((t) => t.name)).toEqual(['shown']);
  });

  it('keeps tasks whose hide/global are truthy but not true, matching only the boolean flag', () => {
    const tasks = parseMiseTasks(json([task('a', { hide: 'yes', global: 1 })]));
    expect(tasks!.map((t) => t.name)).toEqual(['a']);
  });

  it('drops flag-like names so a repo cannot inject mise options through a task name (S1, AC3)', () => {
    const tasks = parseMiseTasks(json([task('-C'), task('--yes'), task('-'), task('a:b'), task('x-y')]));
    expect(tasks!.map((t) => t.command)).toEqual([['mise', 'run', 'a:b'], ['mise', 'run', 'x-y']]);
  });

  it('drops a task with an empty name, which would make `mise run` open its picker', () => {
    expect(parseMiseTasks(json([task(''), task('ok')]))!.map((t) => t.name)).toEqual(['ok']);
  });

  it.each([
    ['non-JSON', 'not json'],
    ['empty stdout', ''],
    ['a JSON object', json({ name: 'a' })],
    ['a JSON string', json('a')],
    ['JSON null', 'null'],
    ['an element without name', json([{ description: 'x' }])],
    ['an element with a numeric name', json([{ name: 3 }])],
    ['a null element', json([null])],
    ['an array element', json([['a']])],
    ['a string element', json(['a'])],
  ])('rejects %s as unexpected output (S2, AC12)', (_label, stdout) => {
    expect(parseMiseTasks(stdout)).toBeNull();
  });

  it('rejects the whole output when valid and invalid elements are mixed, never returning a partial list (S2, AC12)', () => {
    expect(parseMiseTasks(json([task('a'), { name: 1 }, task('b')]))).toBeNull();
  });

  it('ignores unknown fields and never copies them onto the task (S2)', () => {
    const [t] = parseMiseTasks(json([task('a', { run: ['rm -rf /'], env: { SECRET: 'x' }, newField: {} })]))!;
    expect(Object.keys(t!).sort()).toEqual(['command', 'id', 'name', 'source']);
  });
});

describe('miseFailureDetail (S3)', () => {
  it('is the first `mise ERROR` line with the prefix removed', () => {
    const stderr = 'mise WARN  Error loading settings file: TOML parse error\n  |\nmise ERROR error parsing config file: ~/p/mise.toml\nmise ERROR more\n';
    expect(miseFailureDetail(stderr)).toBe('error parsing config file: ~/p/mise.toml');
  });

  it('falls back to the first non-empty line, with any mise level prefix removed, when no ERROR line exists', () => {
    expect(miseFailureDetail('\n   \nmise WARN  something odd\nsecond\n')).toBe('something odd');
    expect(miseFailureDetail('\n\nplain failure\nsecond')).toBe('plain failure');
  });

  it('caps the detail at 200 characters', () => {
    expect(miseFailureDetail(`mise ERROR ${'x'.repeat(500)}`)).toBe('x'.repeat(200));
  });

  it('strips ANSI colour codes and other control characters', () => {
    expect(miseFailureDetail('\u001b[31mmise\u001b[0m \u001b[31mERROR\u001b[0m bad\u0007 thing\r\n')).toBe('bad thing');
  });

  it('is undefined when stderr has no visible text', () => {
    expect(miseFailureDetail('')).toBeUndefined();
    expect(miseFailureDetail(' \n\t\n')).toBeUndefined();
  });
});

describe('hasMiseMarker (AC5)', () => {
  it('lists exactly the 13 recognised config files and task directories', () => {
    expect([...MISE_MARKERS].sort()).toEqual([
      '.config/mise.toml', '.config/mise/config.toml', '.config/mise/tasks', '.mise-tasks', '.mise.local.toml', '.mise.toml',
      '.mise/config.toml', '.mise/tasks', 'mise-tasks', 'mise.local.toml', 'mise.toml', 'mise/config.toml', 'mise/tasks',
    ].sort());
  });

  it('checks markers relative to the project root only', () => {
    const exists = vi.fn<(path: string) => boolean>(() => false);
    expect(hasMiseMarker('/proj', exists)).toBe(false);
    expect(exists.mock.calls.map(([p]) => p)).toEqual(MISE_MARKERS.map((m) => join('/proj', m)));
  });

  it('is true as soon as one marker exists', () => {
    expect(hasMiseMarker('/proj', (p) => p === join('/proj', '.mise/tasks'))).toBe(true);
  });
});

describe('discoverMiseTasks', () => {
  const ENV = { PATH: '/bin', MISE_ENV: 'dev' };

  it('starts no mise process and returns nothing for a root without a marker (AC4, P2)', async () => {
    const root = projectWith();
    writeFileSync(join(root, 'package.json'), '{}');
    const list = lister({ kind: 'ok', stdout: json([task('a')]) });
    expect(await discoverMiseTasks(root, ENV, list)).toEqual({ tasks: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it('does not treat a parent directory marker as the project marker (Decision 2)', async () => {
    const parent = projectWith('mise.toml');
    const root = join(parent, 'child');
    mkdirSync(root);
    const list = lister({ kind: 'ok', stdout: '[]' });
    await discoverMiseTasks(root, ENV, list);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    'mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.config/mise.toml', '.config/mise/config.toml',
    'mise/config.toml', '.mise/config.toml', 'mise-tasks/', '.mise-tasks/', 'mise/tasks/', '.mise/tasks/', '.config/mise/tasks/',
  ])('lists once, in the project root with the given env, when the root has %s (AC5, AC6)', async (marker) => {
    const root = projectWith(marker);
    const list = lister({ kind: 'ok', stdout: json([task('a')]) });
    const r = await discoverMiseTasks(root, ENV, list);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(root, ENV);
    expect(r.tasks.map((t) => t.id)).toEqual(['mise:a']);
  });

  it('returns the parsed tasks and no notice on success (AC1)', async () => {
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'ok', stdout: json([task('b', { description: 'B' })]) }));
    expect(r).toEqual({ tasks: [{ id: 'mise:b', source: 'mise', name: 'b', command: ['mise', 'run', 'b'], description: 'B' }] });
  });

  it('gives a not-found notice and no tasks when mise is not on the PATH (AC10)', async () => {
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'not-found' }));
    expect(r).toEqual({ tasks: [], notice: { source: 'mise', kind: 'not-found' } });
  });

  it('gives a timed-out notice and no tasks when mise was killed at the limit (AC13)', async () => {
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'timed-out' }));
    expect(r).toEqual({ tasks: [], notice: { source: 'mise', kind: 'timed-out' } });
  });

  it('gives an untrusted notice with no detail and no tasks when mise says the config is not trusted (AC11, AC22)', async () => {
    const stderr = 'mise ERROR error parsing config file: ~/p/mise.toml\nmise ERROR Config files in ~/p/mise.toml are not trusted.\nTrust them with `mise trust`.\n';
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'failed', stderr }));
    expect(r).toEqual({ tasks: [], notice: { source: 'mise', kind: 'untrusted' } });
  });

  it('gives a failed notice with the stderr detail and no tasks on any other failure (AC12)', async () => {
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'failed', stderr: 'mise ERROR boom\nmore\n' }));
    expect(r).toEqual({ tasks: [], notice: { source: 'mise', kind: 'failed', detail: 'boom' } });
  });

  it('gives a failed notice without detail when mise wrote no stderr (AC12)', async () => {
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'failed', stderr: '' }));
    expect(r).toEqual({ tasks: [], notice: { source: 'mise', kind: 'failed' } });
  });

  it('gives an unexpected notice and no tasks when stdout is not a task array (AC12)', async () => {
    const r = await discoverMiseTasks(projectWith('mise.toml'), ENV, lister({ kind: 'ok', stdout: json([task('a'), { nope: 1 }]) }));
    expect(r).toEqual({ tasks: [], notice: { source: 'mise', kind: 'unexpected' } });
  });
});
