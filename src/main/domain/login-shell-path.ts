/** Resolves only PATH from an interactive login shell, excluding startup output. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pathCommand = '/usr/bin/printf "\\000METAIDE_PATH_START\\000%s\\000METAIDE_PATH_END\\000" "$PATH"';
const pathFrame = /\0METAIDE_PATH_START\0([^\0]*)\0METAIDE_PATH_END\0/;

/** Returns the framed PATH using inherited environment and home cwd; rejects failed shells and missing or empty frames. */
export async function resolveLoginShellPath(
  shell: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(shell, ['-ilc', pathCommand], {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    }));
  } catch (cause) {
    throw new Error('Login shell PATH resolution failed; check shell startup files and shell availability', { cause });
  }
  const match = pathFrame.exec(stdout);
  const path = match?.[1];
  if (path === undefined) throw new Error('Login shell did not emit a complete framed PATH');
  if (path.length === 0) throw new Error('Login shell emitted an empty PATH');
  return path;
}
