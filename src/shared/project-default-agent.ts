import type { CliProfile } from './types';

/** Explicit project default choice; null restores the application launch commands. */
export interface ProjectDefaultAgentRequest {
  readonly projectId: number;
  readonly name: string | null;
}

/** One project-over-global deduplicated CLI profile offered by both default selectors. */
export interface ScopedCliProfile extends CliProfile {
  scope: 'project' | 'global';
}
