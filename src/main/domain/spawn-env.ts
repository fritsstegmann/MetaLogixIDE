import type { Project } from '@shared/types';

/**
 * Inputs for computing a spawn's environment. Precedence, lowest to highest:
 * inherited < template env < project variables; hook variables are layered
 * on later by the Claude launch decorator.
 */
export interface SpawnEnvInput {
  project: Pick<Project, 'path' | 'config'>;
  /** Final form; not interpolated here. */
  templateEnv: Record<string, string>;
  /** The main process environment at spawn time; never read from `process.env` inside the domain. */
  inherited: Readonly<Record<string, string | undefined>>;
  homeDir: string;
}

export interface SpawnEnv {
  /** Overlay for `PtyManager.spawn`: template env ⊕ interpolated project variables. */
  env: Record<string, string>;
  /** inherited ⊕ env — the lookup for `${env.NAME}` in template argv (AC13). */
  lookup: Record<string, string>;
}

export function resolveSpawnEnv(input: SpawnEnvInput): SpawnEnv {
  throw new Error(`not implemented: resolveSpawnEnv(${input.project.path})`);
}
