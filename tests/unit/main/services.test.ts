import { describe, it, expect, afterEach } from 'vitest';
import { buildServices } from '@main/services';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../migrations');

function tempOpts() {
  return { dbPath: join(mkdtempSync(join(tmpdir(), 'svc-')), 'db'), migrationsDir };
}

describe('buildServices — METAIDE_CLAUDE_PERMISSION_MODE env hook (AC21)', () => {
  afterEach(() => {
    delete process.env.METAIDE_CLAUDE_PERMISSION_MODE;
    delete process.env.METAIDE_DEFAULT_LAUNCH_FIRST;
  });

  it('auto on a fresh DB sets the mode and rewrites the managed argv', () => {
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'auto';
    const services = buildServices(tempOpts());
    expect(services.settings.get('claude_permission_mode')).toBe('auto');
    expect(services.settings.get('default_launch_cmd.first').argv).toEqual(['claude', '--permission-mode', 'auto']);
    expect(services.settings.get('default_launch_cmd.subsequent').argv).toEqual(['claude', '--permission-mode', 'auto', '--continue']);
  });

  it('does not override a DB that already has a chosen mode', () => {
    const opts = tempOpts();
    // First boot with no env override chooses nothing; simulate a user
    // having already chosen bypass by building services once, then setting
    // the mode directly before the second boot that carries the env var.
    const first = buildServices(opts);
    first.settings.set('claude_permission_mode', 'bypass');
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'auto';
    const second = buildServices(opts);
    expect(second.settings.get('claude_permission_mode')).toBe('bypass');
  });

  it('an invalid value throws at startup naming the var and the allowed values', () => {
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'plan';
    expect(() => buildServices(tempOpts())).toThrow(/METAIDE_CLAUDE_PERMISSION_MODE/);
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'plan';
    expect(() => buildServices(tempOpts())).toThrow(/auto/);
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'plan';
    expect(() => buildServices(tempOpts())).toThrow(/bypass/);
  });

  it('METAIDE_DEFAULT_LAUNCH_FIRST still wins as the seeded first command, and a non-Claude override is left unchanged', () => {
    process.env.METAIDE_DEFAULT_LAUNCH_FIRST = JSON.stringify({ argv: ['my-tool', '--flag'], env: {} });
    process.env.METAIDE_CLAUDE_PERMISSION_MODE = 'auto';
    const services = buildServices(tempOpts());
    // Not a Claude argv, so the permission-flag rewrite leaves it untouched
    // even though a mode was chosen via the env hook.
    expect(services.settings.get('default_launch_cmd.first').argv).toEqual(['my-tool', '--flag']);
    expect(services.settings.get('claude_permission_mode')).toBe('auto');
  });
});
