/**
 * Spawn-time injection of the app's hook settings into Claude launches.
 * A Claude argv gets `--settings <path>` after argv[0] and a fresh per-spawn
 * session id + token in its env (token never in argv). Anything else —
 * non-Claude argv, a user-supplied `--settings`, or hooks not available —
 * is returned as the same object, untouched (AC5, AC6, AC22, AC27). Every
 * spawn supersedes the shell's previous hook session: an injected spawn
 * replaces it via `issue`, any other spawn releases it, so a stale session
 * never outlives the process that owned it.
 */
import type { ResolvedLaunch } from '@main/domain/launch';
import { isClaudeArgv } from '@main/domain/claude-permission-mode';
import type { SpawnDecorator } from '@main/pty/manager';
import { SHELL_ENV, TOKEN_ENV } from './protocol';
import type { HookSession, ShellKey } from './session-registry';

/** Collaborators: the session registry and the current settings-file path (null while hooks are unavailable). */
export interface LaunchDecoratorDeps {
  sessions: { issue(shell: ShellKey): HookSession; release(shell: ShellKey): void };
  settingsPath: () => string | null;
}

function hasSettingsFlag(argv: readonly string[]): boolean {
  return argv.slice(1).some((arg) => arg === '--settings' || arg.startsWith('--settings='));
}

/** Builds the `PtyManager` spawn decorator; see the module docblock for the rule. */
export function createLaunchDecorator(deps: LaunchDecoratorDeps): SpawnDecorator {
  return (projectId: number, shellIndex: number, launch: ResolvedLaunch): ResolvedLaunch => {
    const shell = { projectId, shellIndex };
    const settingsPath = isClaudeArgv(launch.argv) && !hasSettingsFlag(launch.argv) ? deps.settingsPath() : null;
    if (settingsPath === null) {
      deps.sessions.release(shell);
      return launch;
    }
    const session = deps.sessions.issue(shell);
    const [bin, ...rest] = launch.argv;
    return {
      ...launch,
      argv: [bin!, '--settings', settingsPath, ...rest],
      env: { ...launch.env, [SHELL_ENV]: session.id, [TOKEN_ENV]: session.token },
    };
  };
}
