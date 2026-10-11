import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { findCliProfile, resolveLaunch } from '@main/domain/launch';
import { setProjectDefaultAgent } from '@main/domain/project-default-agent';
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
    const r = resolveLaunch(project(), fakeSettings, '/home/u', {});
    expect(r.variant).toBe('first');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first'].argv);
    expect(r.cwd).toBe('/r/x');
  });

  it('uses subsequent variant once first_launched_at is set', () => {
    const r = resolveLaunch(
      project({ firstLaunchedAt: '2026-07-18 10:00:00' }),
      fakeSettings,
      '/home/u',
      {},
    );
    expect(r.variant).toBe('subsequent');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.subsequent'].argv);
  });

  it('project override wins over global default', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['echo', 'hello'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['echo', 'hello']);
  });

  it('interpolates PROJECT_PATH', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['run', '${PROJECT_PATH}'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['run', '/r/x']);
  });

  it('respects cwd_override', () => {
    const p = project({ config: { cwdOverride: '/r/x/sub' } });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.cwd).toBe('/r/x/sub');
  });

  it('AC16 — after applying Auto, both first and subsequent argv carry --permission-mode auto', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'lr-')), 'db'));
    runMigrations(db, resolve(__dirname, '../../../../migrations'));
    const settings = new SettingsRepo(db);
    settings.seedDefaults();
    applyClaudePermissionMode(settings, 'auto');

    const first = resolveLaunch(project(), settings, '/home/u', {});
    expect(first.argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));

    const subsequent = resolveLaunch(
      project({ firstLaunchedAt: '2026-07-18 10:00:00' }),
      settings,
      '/home/u',
      {},
    );
    expect(subsequent.argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
  });
});

describe('resolveLaunch — project env (AC10–AC14)', () => {
  const tpl = (argv: string[], env: Record<string, string> = {}) => ({
    launchCmd: { first: { argv, env } },
  });

  it('project env overrides template env in the output env', () => {
    const p = project({
      config: {
        ...tpl(['run'], { NODE_ENV: 'production', T: 't' }),
        env: { NODE_ENV: 'development' },
      },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', {}).env).toEqual({
      NODE_ENV: 'development',
      T: 't',
    });
  });

  it('project values resolve ${env.PATH} against the inherited env (AC12)', () => {
    const p = project({
      config: { ...tpl(['run']), env: { PATH: '${PROJECT_PATH}/bin:${env.PATH}' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { PATH: '/usr/bin' }).env.PATH).toBe(
      '/r/x/bin:/usr/bin',
    );
  });

  it('D6 clash — argv ${env.X} sees the project value when template and project both set X (AC13)', () => {
    const p = project({
      config: { ...tpl(['run', '${env.X}'], { X: 'tpl' }), env: { X: 'proj' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { X: 'inh' }).argv).toEqual(['run', 'proj']);
  });

  it('D6 interpolated — argv sees the expanded project value, not the raw token (AC13)', () => {
    const p = project({
      config: { ...tpl(['run', '${env.X}']), env: { X: '${PROJECT_PATH}/bin' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', {}).argv).toEqual(['run', '/r/x/bin']);
  });

  it('argv ${env.NAME} falls back to the inherited env (AC13)', () => {
    const p = project({ config: tpl(['run', '${env.ONLY_INHERITED}']) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { ONLY_INHERITED: 'inh' }).argv).toEqual([
      'run',
      'inh',
    ]);
  });

  it('argv ${env.NAME} sees the template value over the inherited one (AC13)', () => {
    const p = project({ config: tpl(['run', '${env.X}'], { X: 'tpl' }) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { X: 'inh' }).argv).toEqual(['run', 'tpl']);
  });

  it('argv ${env.NAME} unset everywhere resolves to the empty string (AC13)', () => {
    const p = project({
      config: { ...tpl(['run', '[${env.UNSET_EVERYWHERE}]'], { T: 't' }), env: { P: 'p' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { I: 'i' }).argv).toEqual(['run', '[]']);
  });

  it('AC13a / D7 — template env ${env.P} still resolves to the raw project value', () => {
    const p = project({
      config: { ...tpl(['run'], { T: '${env.P}' }), env: { P: '${PROJECT_PATH}/raw' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { P: 'inh' }).env.T).toBe(
      '${PROJECT_PATH}/raw',
    );
  });

  it('AC13a / D7 — template env does not see the inherited env', () => {
    const p = project({ config: tpl(['run'], { T: '[${env.ONLY_INHERITED}]' }) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { ONLY_INHERITED: 'inh' }).env.T).toBe('[]');
  });

  it('AC13a / D7 — template env ${env.Y} sees another template value, which wins over the project', () => {
    const p = project({
      config: { ...tpl(['run'], { T: '${env.Y}', Y: 'tpl-y' }), env: { Y: 'proj-y' } },
    });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.env.T).toBe('tpl-y');
    expect(r.env.Y).toBe('proj-y');
  });

  it('AC13a / D7 — template env tokens HOME, PROJECT_PATH, PROJECT_NAME resolve as today', () => {
    const p = project({ config: tpl(['run'], { T: '${HOME}|${PROJECT_PATH}|${PROJECT_NAME}' }) });
    expect(resolveLaunch(p, fakeSettings, '/home/u', { HOME: '/other' }).env.T).toBe(
      '/home/u|/r/x|x',
    );
  });

  it.each([
    ['global default', {}],
    ['project launchCmd', tpl(['run', '${env.T}', '${PROJECT_NAME}'], { T: '${HOME}/t', U: 'u' })],
  ])('AC14 — no project vars: env equals the interpolated template env (%s)', (_label, config) => {
    const p = project({ config });
    const r = resolveLaunch(p, fakeSettings, '/home/u', { PATH: '/usr/bin' });
    const templateEnv =
      'launchCmd' in config
        ? config.launchCmd.first.env
        : DEFAULT_SETTINGS['default_launch_cmd.first'].env;
    const expected = Object.fromEntries(
      Object.entries(templateEnv).map(([k, v]) => [k, v.replace('${HOME}', '/home/u')]),
    );
    expect(r.env).toStrictEqual(expected);
  });

  it('a CLI profile picked by defaultCliName gets the project env layered on top', () => {
    const p = project({
      config: {
        defaultCliName: 'codex',
        cliProfiles: [{ name: 'codex', argv: ['codex', '${env.K}'], env: { K: 'profile' } }],
        env: { K: 'proj' },
      },
    });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['codex', 'proj']);
    expect(r.env).toEqual({ K: 'proj' });
  });

  it.each([
    ['without project variables', undefined],
    ['with project variables', { Y: 'y' }],
  ])('AC19 / D14 — argv ${env.X} gets the interpolated template value %s', (_label, env) => {
    const p = project({
      config: { ...tpl(['run', '${env.X}'], { X: '${HOME}/t' }), ...(env ? { env } : {}) },
    });
    const r = resolveLaunch(p, fakeSettings, '/home/u', {});
    expect(r.argv).toEqual(['run', '/home/u/t']);
    expect(r.env.X).toBe('/home/u/t');
  });

  it('drops a stored reserved project name from the output env', () => {
    const p = project({
      config: { ...tpl(['claude']), env: { METAIDE_HOOK_TOKEN: 'evil', A: '1' } },
    });
    expect(resolveLaunch(p, fakeSettings, '/home/u', {}).env).toEqual({ A: '1' });
  });
});

describe('resolveLaunch — app-wide env (AC9, AC10)', () => {
  const settingsWith = (app_env: Record<string, string>) =>
    ({ get: (k: string) => (k === 'app_env' ? app_env : DEFAULT_SETTINGS[k as keyof typeof DEFAULT_SETTINGS]) }) as unknown as import('@main/repos/settings-repo').SettingsRepo;

  it('an app-wide variable reaches the primary launch env with no project or template value', () => {
    const p = project();
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.env.X).toBe('app');
  });

  it('argv ${env.X} sees the app-wide value when there is no project or template value', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['run', '${env.X}'], env: {} } } } });
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.argv).toEqual(['run', 'app']);
  });

  it('a project value still wins over an app-wide value of the same name', () => {
    const p = project({ config: { env: { X: 'proj' } } });
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.env.X).toBe('proj');
  });

  it('finding 5 — template env interpolation does not see app-wide variables', () => {
    const p = project({
      config: { launchCmd: { first: { argv: ['run'], env: { T: '[${env.X}]' } } } },
    });
    const r = resolveLaunch(p, settingsWith({ X: 'app' }), '/home/u', {});
    expect(r.env.T).toBe('[]');
  });
});

describe('resolveLaunch — project default-agent regression matrix', () => {
  let db: Database;
  let settings: SettingsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, resolve(__dirname, '../../../../migrations'));
    settings = new SettingsRepo(db);
    settings.seedDefaults();
    settings.set('default_cli_profiles', [{ name: 'Agent', argv: ['global-agent', 'global-arg'], env: { SOURCE: 'global' } }]);
    settings.set('default_launch_cmd.first', { argv: ['global-first'], env: { VARIANT: 'first' } });
    settings.set('default_launch_cmd.subsequent', { argv: ['global-subsequent', '--continue'], env: { VARIANT: 'subsequent' } });
    settings.set('app_env', { APP: 'app' });
  });

  afterEach(() => db.close());

  it('project catalog shadows a same-name global and missing lookup returns null', () => {
    const profile = { name: 'Agent', argv: ['local'], env: { SOURCE: 'local' } };
    const p = project({ config: { cliProfiles: [profile] } });
    expect(findCliProfile(p, settings, 'Agent')).toBe(profile);
    expect(findCliProfile(project(), settings, 'Agent')).toStrictEqual(settings.get('default_cli_profiles')[0]);
    expect(findCliProfile(p, settings, 'missing')).toBeNull();
  });

  it.each([null, '2026-09-01 10:00:00'])('named project profile uses identical argv/env without invented resume flags (%j)', (firstLaunchedAt) => {
    const p = project({
      firstLaunchedAt,
      config: {
        defaultCliName: 'Agent', cwdOverride: '/r/x/sub',
        cliProfiles: [{ name: 'Agent', argv: ['local-agent', '${env.SOURCE}', '${env.BIN}', '${PROJECT_NAME}'], env: { SOURCE: 'profile', TEMPLATE: '${HOME}/tpl' } }],
        env: { SOURCE: 'project', BIN: '${PROJECT_PATH}/bin:${env.PATH}' },
      },
    });
    const launch = resolveLaunch(p, settings, '/home/u', { PATH: '/usr/bin' });
    expect(launch.argv).toStrictEqual(['local-agent', 'project', '/r/x/bin:/usr/bin', 'x']);
    expect(launch.env).toStrictEqual({ APP: 'app', SOURCE: 'project', TEMPLATE: '/home/u/tpl', BIN: '/r/x/bin:/usr/bin' });
    expect(launch.cwd).toBe('/r/x/sub');
    expect(launch.variant).toBe(firstLaunchedAt ? 'subsequent' : 'first');
  });

  it.each([null, '2026-09-01 10:00:00'])('named global profile uses its existing command for both variants (%j)', (firstLaunchedAt) => {
    const launch = resolveLaunch(project({ firstLaunchedAt, config: { defaultCliName: 'Agent' } }), settings, '/home/u', {});
    expect(launch.argv).toStrictEqual(['global-agent', 'global-arg']);
    expect(launch.env).toStrictEqual({ APP: 'app', SOURCE: 'global' });
  });

  it.each([undefined, null, 'missing'])('unset, reset or stale saved name %j uses current global first/subsequent commands', (name) => {
    const config = name === undefined ? {} : { defaultCliName: name };
    const first = project({ config });
    const subsequent = project({ config, firstLaunchedAt: '2026-09-01 10:00:00' });
    expect(resolveLaunch(first, settings, '/home/u', {}).argv).toStrictEqual(['global-first']);
    expect(resolveLaunch(subsequent, settings, '/home/u', {}).argv).toStrictEqual(['global-subsequent', '--continue']);
    expect(resolveLaunch(first, settings, '/home/u', {}).env).toStrictEqual({ APP: 'app', VARIANT: 'first' });
    expect(resolveLaunch(subsequent, settings, '/home/u', {}).env).toStrictEqual({ APP: 'app', VARIANT: 'subsequent' });
    settings.set('default_launch_cmd.first', { argv: ['edited-first'], env: {} });
    settings.set('default_launch_cmd.subsequent', { argv: ['edited-subsequent'], env: {} });
    expect(resolveLaunch(first, settings, '/home/u', {}).argv).toStrictEqual(['edited-first']);
    expect(resolveLaunch(subsequent, settings, '/home/u', {}).argv).toStrictEqual(['edited-subsequent']);
    expect(first.config).toStrictEqual(config);
    expect(subsequent.config).toStrictEqual(config);
  });

  it.each(['Agent', 'missing', null])('untouched first-only legacy override takes precedence only for its variant (name %j)', (name) => {
    const config = { defaultCliName: name, launchCmd: { first: { argv: ['legacy-first'], env: { LEGACY: 'yes' } } } };
    const first = project({ config });
    const subsequent = project({ config, firstLaunchedAt: '2026-09-01 10:00:00' });
    expect(resolveLaunch(first, settings, '/home/u', {}).argv).toStrictEqual(['legacy-first']);
    expect(resolveLaunch(first, settings, '/home/u', {}).env).toStrictEqual({ APP: 'app', LEGACY: 'yes' });
    expect(resolveLaunch(subsequent, settings, '/home/u', {}).argv)
      .toStrictEqual(name === 'Agent' ? ['global-agent', 'global-arg'] : ['global-subsequent', '--continue']);
    expect(first.config).toStrictEqual(config);
  });

  it('untouched subsequent-only and both-variant overrides retain variant-specific precedence', () => {
    const config = { defaultCliName: 'Agent', launchCmd: { subsequent: { argv: ['legacy-resume'], env: {} } } };
    expect(resolveLaunch(project({ config }), settings, '/home/u', {}).argv).toStrictEqual(['global-agent', 'global-arg']);
    expect(resolveLaunch(project({ config, firstLaunchedAt: 'launched' }), settings, '/home/u', {}).argv).toStrictEqual(['legacy-resume']);
    const both = { ...config, launchCmd: { ...config.launchCmd, first: { argv: ['legacy-first'], env: {} } } };
    expect(resolveLaunch(project({ config: both }), settings, '/home/u', {}).argv).toStrictEqual(['legacy-first']);
    expect(resolveLaunch(project({ config: both, firstLaunchedAt: 'launched' }), settings, '/home/u', {}).argv).toStrictEqual(['legacy-resume']);
  });

  it.each(['Agent', null])('explicit choice %j replaces both variants before next resolution', (name) => {
    let p = project({
      config: { defaultCliName: name, launchCmd: { first: { argv: ['legacy-first'], env: {} }, subsequent: { argv: ['legacy-subsequent'], env: {} } } },
    });
    const projects = {
      get: () => p,
      updateConfig: (_id: number, patch: Partial<Project['config']>): Project => {
        p = { ...p, config: { ...p.config, ...patch } };
        return p;
      },
    };
    expect(setProjectDefaultAgent({ projects, settings }, { projectId: p.id, name }).ok).toBe(true);
    expect(resolveLaunch(p, settings, '/home/u', {}).argv).toStrictEqual(name ? ['global-agent', 'global-arg'] : ['global-first']);
    expect(resolveLaunch({ ...p, firstLaunchedAt: 'launched' }, settings, '/home/u', {}).argv)
      .toStrictEqual(name ? ['global-agent', 'global-arg'] : ['global-subsequent', '--continue']);
    expect(p.firstLaunchedAt).toBeNull();
    expect(p.config).toStrictEqual({ defaultCliName: name, launchCmd: null });
  });
});
