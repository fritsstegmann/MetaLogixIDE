/**
 * Name and value rules for per-project environment variables. One source of
 * truth for the editor (inline row reasons) and the `projects:update-config`
 * IPC boundary (reject before write).
 */

/** Names with this prefix (case-insensitive) are reserved for the app's own variables. */
export const RESERVED_ENV_PREFIX = 'METAIDE_';
export const MAX_ENV_NAME_LENGTH = 255;

export type EnvNameProblem = 'invalid' | 'too-long' | 'reserved';
export type EnvValueProblem = 'nul';

/** Why `name` cannot be a project variable name, or null when it can. */
export function envNameProblem(name: string): EnvNameProblem | null {
  throw new Error(`not implemented: envNameProblem(${name.length})`);
}

/** Why `value` cannot be a project variable value, or null when it can. */
export function envValueProblem(value: string): EnvValueProblem | null {
  throw new Error(`not implemented: envValueProblem(${value.length})`);
}

export type ProjectEnvParse =
  | { ok: true; env: Record<string, string> }
  /** `error` names the offending key, never a value. */
  | { ok: false; error: string };

/** Validates an untrusted project env map as received over IPC. */
export function parseProjectEnv(input: unknown): ProjectEnvParse {
  throw new Error(`not implemented: parseProjectEnv(${typeof input})`);
}
