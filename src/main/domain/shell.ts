import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/**
 * The user's login shell binary. On POSIX this is $SHELL (zsh fallback);
 * Windows has no $SHELL, so default to PowerShell — cmd.exe is too bare
 * for a dev tool and $ComSpec points there.
 */
export function defaultShellBin(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

/** Argv for a plain interactive terminal ("New Terminal" / ⌘T). */
export function defaultShellArgv(): string[] {
  if (process.platform === 'win32') return ['powershell.exe', '-NoLogo'];
  return [defaultShellBin(), '-l'];
}

/**
 * Make an argv spawnable by node-pty on Windows. ConPTY uses CreateProcess,
 * which only launches real executables — npm-style shims like claude.cmd
 * need a `cmd.exe /c` wrapper, and bare names must be resolved against
 * PATH/PATHEXT ourselves so we can tell which case we're in. POSIX argv
 * passes through untouched.
 */
export function toSpawnableArgv(argv: string[]): string[] {
  const cmd = argv[0];
  if (process.platform !== 'win32' || !cmd) return argv;
  const rest = argv.slice(1);
  const resolved = whichWindows(cmd);
  if (!resolved) return argv;
  const ext = extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    return [process.env.ComSpec || 'cmd.exe', '/c', resolved, ...rest];
  }
  return [resolved, ...rest];
}

function whichWindows(cmd: string): string | null {
  // Explicit paths are the user's business — use as given.
  if (isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/')) return cmd;
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = extname(cmd)
    ? ['']
    : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
