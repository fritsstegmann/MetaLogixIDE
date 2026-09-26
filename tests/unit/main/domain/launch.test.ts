import { describe, it, expect } from 'vitest';
import { resolveLaunch } from '@main/domain/launch';
import type { Project } from '@shared/types';
import { DEFAULT_SETTINGS } from '@main/repos/settings-repo';
import { applyClaudePermissionMode } from '@main/domain/claude-permission-mode';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, rootId: 1, path: '/r/x', name: 'x',
    metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false,
    firstLaunchedAt: null, config: {}, ...overrides,
  };
}

const fakeSettings = { get: (k: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[k] } as unknown as import('@main/repos/settings-repo').SettingsRepo;

describe('resolveLaunch', () => {
  it('uses first variant when project has never launched', () => {
    const r = resolveLaunch(project(), fakeSettings, '/home/u');
    expect(r.variant).toBe('first');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first'].argv);
    expect(r.cwd).toBe('/r/x');
  });

  it('uses subsequent variant once first_launched_at is set', () => {
    const r = resolveLaunch(project({ firstLaunchedAt: '2026-07-18 10:00:00' }), fakeSettings, '/home/u');
    expect(r.variant).toBe('subsequent');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.subsequent'].argv);
  });

  it('project override wins over global default', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['echo', 'hello'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u');
    expect(r.argv).toEqual(['echo', 'hello']);
  });

  it('interpolates PROJECT_PATH', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['run', '${PROJECT_PATH}'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u');
    expect(r.argv).toEqual(['run', '/r/x']);
  });

  it('respects cwd_override', () => {
    const p = project({ config: { cwdOverride: '/r/x/sub' } });
    const r = resolveLaunch(p, fakeSettings, '/home/u');
    expect(r.cwd).toBe('/r/x/sub');
  });

  it('AC16 — after applying Auto, both first and subsequent argv carry --permission-mode auto', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'lr-')), 'db'));
    runMigrations(db, resolve(__dirname, '../../../../migrations'));
    const settings = new SettingsRepo(db);
    settings.seedDefaults();
    applyClaudePermissionMode(settings, 'auto');

    const first = resolveLaunch(project(), settings, '/home/u');
    expect(first.argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));

    const subsequent = resolveLaunch(project({ firstLaunchedAt: '2026-07-18 10:00:00' }), settings, '/home/u');
    expect(subsequent.argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
  });
});
