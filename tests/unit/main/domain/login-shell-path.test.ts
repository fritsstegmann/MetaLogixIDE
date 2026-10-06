/** Exercises login-shell PATH discovery against isolated zsh startup files. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoginShellPath } from '@main/domain/login-shell-path';

const homes: string[] = [];
const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function fixture(zshrc: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'metaide-login-path-')));
  homes.push(home);
  writeFileSync(join(home, '.zshenv'), 'unsetopt GLOBAL_RCS\n');
  writeFileSync(join(home, '.zshrc'), zshrc);
  return {
    home,
    env: { ...process.env, HOME: home, ZDOTDIR: home, PATH: finderPath },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('resolveLoginShellPath', () => {
  it('discovers interactive .zshrc runtime PATH and ignores startup and logout banners', async () => {
    const { home, env } = fixture([
      '/usr/bin/printf "startup banner\\nPATH=/not/the/path\\n"',
      'export PATH="$HOME/managed runtime/bin:$PATH"',
    ].join('\n'));
    writeFileSync(join(home, '.zprofile'), 'export PATH="/login-only/bin:$PATH"\n');
    writeFileSync(join(home, '.zlogout'), '/usr/bin/printf "logout banner\\n"\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).resolves.toBe(
      `${home}/managed runtime/bin:/login-only/bin:${finderPath}`,
    );
    expect(env.PATH).toBe(finderPath);
  });

  it('runs in the user home and inherits environment without returning other variables', async () => {
    const { home, env } = fixture('export PATH="$PWD/$METAIDE_RUNTIME_DIR:$PATH"\n');
    env.METAIDE_RUNTIME_DIR = 'inherited/bin';

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).resolves.toBe(
      `${home}/inherited/bin:${finderPath}`,
    );
  });

  it('rejects absent framing even when the shell prints a plausible PATH', async () => {
    const { home, env } = fixture('exec /usr/bin/printf "/managed/bin:/usr/bin\\n"\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).rejects.toThrow('framed PATH');
  });

  it('rejects incomplete framing', async () => {
    const { home, env } = fixture('exec /usr/bin/printf "\\000METAIDE_PATH_START\\000/managed/bin"\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).rejects.toThrow('framed PATH');
  });

  it('rejects an empty PATH instead of retaining a plausible banner', async () => {
    const { home, env } = fixture('/usr/bin/printf "/managed/bin:/usr/bin\\n"\nunset PATH\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).rejects.toThrow('empty PATH');
  });

  it('rejects unsuccessful shell startup', async () => {
    const { home, env } = fixture('exit 7\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).rejects.toThrow('Login shell PATH resolution failed');
  });

  it('rejects an unavailable configured shell instead of switching shells', async () => {
    const { home, env } = fixture('export PATH="/managed/bin"\n');

    await expect(resolveLoginShellPath(join(home, 'missing-shell'), home, env)).rejects.toThrow(
      'Login shell PATH resolution failed',
    );
  });

  it('rejects excessive startup output rather than returning a truncated PATH', async () => {
    const { home, env } = fixture('/usr/bin/head -c 1100000 /dev/zero\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).rejects.toThrow(
      'Login shell PATH resolution failed',
    );
  });

  it('terminates shell startup that never finishes', async () => {
    const { home, env } = fixture('exec /bin/sleep 60\n');

    await expect(resolveLoginShellPath('/bin/zsh', home, env)).rejects.toThrow(
      'Login shell PATH resolution failed',
    );
  }, 15_000);
});
