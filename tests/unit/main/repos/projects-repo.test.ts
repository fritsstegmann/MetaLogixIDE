import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { SettingsRepo } from '@main/repos/settings-repo';
import { setProjectDefaultAgent } from '@main/domain/project-default-agent';
import type { ProjectConfig } from '@shared/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fresh() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'p-')), 'db'));
  runMigrations(db, migrationsDir);
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const root = roots.add('/tmp/root');
  return { db, projects, root };
}

describe('ProjectsRepo', () => {
  it('upserts and lists projects', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/alpha', 'alpha');
    expect(p.name).toBe('alpha');
    expect(projects.list()).toHaveLength(1);
  });

  it('upsert is idempotent by path', () => {
    const { projects, root } = fresh();
    const p1 = projects.upsert(root.id, '/tmp/root/alpha', 'alpha');
    const p2 = projects.upsert(root.id, '/tmp/root/alpha', 'alpha-renamed');
    expect(p2.id).toBe(p1.id);
    expect(p2.name).toBe('alpha-renamed');
  });

  it('setFirstLaunched persists a timestamp', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/x', 'x');
    projects.setFirstLaunched(p.id, new Date('2026-07-18T10:00:00Z'));
    expect(projects.get(p.id)!.firstLaunchedAt).toBe('2026-07-18 10:00:00');
  });

  it('updateConfig merges JSON', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/y', 'y');
    const updated = projects.updateConfig(p.id, { model: 'opus' });
    expect(updated.config.model).toBe('opus');
  });

  it('updateConfig replaces the whole env map and keeps other fields (AC4)', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/e', 'e');
    projects.updateConfig(p.id, { env: { A: '1', C: '3' }, notes: 'n' });
    const updated = projects.updateConfig(p.id, { env: { B: '2' } });
    expect(updated.config).toStrictEqual({ env: { B: '2' }, notes: 'n' });
    expect(projects.get(p.id)!.config).toStrictEqual({ env: { B: '2' }, notes: 'n' });
  });

  it('updateConfig keeps env insertion order across the JSON round-trip (AC2)', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/o', 'o');
    projects.updateConfig(p.id, { env: { Z: '1', A: '2', _M: '3' } });
    expect(Object.keys(projects.get(p.id)!.config.env!)).toEqual(['Z', 'A', '_M']);
  });

  it('listRecents returns latest N by last_opened_at', () => {
    const { projects, root } = fresh();
    const a = projects.upsert(root.id, '/tmp/root/a', 'a');
    const b = projects.upsert(root.id, '/tmp/root/b', 'b');
    projects.markLastOpened(a.id, new Date('2026-07-17'));
    projects.markLastOpened(b.id, new Date('2026-07-18'));
    const recents = projects.listRecents(10);
    expect(recents[0]!.id).toBe(b.id);
    expect(recents[1]!.id).toBe(a.id);
  });
});

describe('project default-agent persistence', () => {
  it.each(['Agent', null])('persists explicit choice %j across reopening without changing other data', (name) => {
    const dir = mkdtempSync(join(tmpdir(), 'default-agent-'));
    const path = join(dir, 'db');
    const db = openDb(path);
    runMigrations(db, migrationsDir);
    const projects = new ProjectsRepo(db);
    const settings = new SettingsRepo(db);
    settings.seedDefaults();
    settings.set('default_cli_profiles', [{ name: 'Agent', argv: ['global-agent'] }]);
    const root = new RootsRepo(db).add('/projects');
    const a = projects.upsert(root.id, '/projects/a', 'a');
    const b = projects.upsert(root.id, '/projects/b', 'b');
    const config: ProjectConfig = {
      defaultCliName: name,
      launchCmd: { first: { argv: ['legacy-first'], env: {} }, subsequent: { argv: ['legacy-sub'], env: {} } },
      env: { KEEP: '${PROJECT_PATH}', EMPTY: '' }, cwdOverride: '/projects/a/sub',
      model: 'opus', notes: 'notes', linkedMetaprojectProjectId: 'linked',
      cliProfiles: [{ name: 'Agent', argv: ['local-agent'], env: { PROFILE: 'keep' }, icon: 'custom' }],
    };
    projects.updateConfig(a.id, config);
    projects.setFirstLaunched(a.id, new Date('2026-09-01T10:00:00Z'));
    projects.markLastOpened(a.id, new Date('2026-09-02T10:00:00Z'));
    projects.setPinned(a.id, true);
    projects.updateConfig(b.id, { defaultCliName: 'B', launchCmd: { first: { argv: ['b-legacy'], env: {} } } });
    const beforeA = projects.get(a.id);
    const beforeB = projects.get(b.id);
    const beforeSettings = settings.getAll();
    const result = setProjectDefaultAgent({ projects, settings }, { projectId: a.id, name });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const expected = { ...beforeA, config: { ...config, defaultCliName: name, launchCmd: null } };
    expect(result.project).toStrictEqual(expected);
    expect(projects.get(a.id)).toStrictEqual(expected);
    expect(projects.get(b.id)).toStrictEqual(beforeB);
    expect(settings.getAll()).toStrictEqual(beforeSettings);
    db.close();
    const reopened = openDb(path);
    try {
      expect(new ProjectsRepo(reopened).get(a.id)).toStrictEqual(expected);
      expect(new ProjectsRepo(reopened).get(b.id)).toStrictEqual(beforeB);
      expect(new SettingsRepo(reopened).getAll()).toStrictEqual(beforeSettings);
    } finally {
      reopened.close();
    }
  });

  it('a real SQLite write failure leaves both variants and other project data intact', () => {
    const { db, projects, root } = fresh();
    const settings = new SettingsRepo(db);
    settings.seedDefaults();
    const a = projects.upsert(root.id, '/tmp/root/a', 'a');
    const before = projects.updateConfig(a.id, {
      defaultCliName: 'Claude', notes: 'keep',
      launchCmd: { first: { argv: ['legacy'], env: {} }, subsequent: { argv: ['resume'], env: {} } },
    });
    db.exec("CREATE TRIGGER reject_default_update BEFORE UPDATE OF config_json ON projects BEGIN SELECT RAISE(ABORT, 'blocked write'); END");
    try {
      expect(() => setProjectDefaultAgent({ projects, settings }, { projectId: a.id, name: null })).toThrow(/blocked write/);
      expect(projects.get(a.id)).toStrictEqual(before);
    } finally {
      db.close();
    }
  });
});
