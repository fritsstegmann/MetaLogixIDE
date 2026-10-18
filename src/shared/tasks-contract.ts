/**
 * Shared contract for the Tasks panel: task sources, the task shape, the
 * per-source notices discovery can return, and the user-facing copy. Main
 * sends notice kinds; the renderer maps them to text through TASKS_COPY.
 */

/** Where a task was discovered. */
export type TaskSource = 'npm' | 'make' | 'compose' | 'mise';

/** Display order of the Tasks panel groups; mise comes last. */
export const TASK_SOURCES: readonly TaskSource[] = ['npm', 'make', 'compose', 'mise'];

export interface TaskDef {
  id: string;                             // stable id used by the run RPC: `<source>:<name>`
  source: TaskSource;
  name: string;
  command: string[];                      // argv to spawn
  description?: string;
}

/** Why mise tasks could not be listed. */
export type TaskNoticeKind = 'not-found' | 'untrusted' | 'timed-out' | 'failed' | 'unexpected';

/** A source that could not be listed. `detail` is set only for `failed` (first line of mise's stderr). */
export interface TaskNotice {
  source: 'mise';
  kind: TaskNoticeKind;
  detail?: string;
}

/** Response of `tasks:discover`. */
export interface TasksDiscovery {
  tasks: TaskDef[];
  notices: TaskNotice[];
}

export const TASKS_COPY = {
  sectionTitle: {
    npm: 'npm scripts',
    make: 'Makefile',
    compose: 'docker compose',
    mise: 'mise',
  } satisfies Record<TaskSource, string>,
  empty: 'No package.json scripts, Makefile targets, compose services, or mise tasks in this project.',
  notice: {
    'not-found': 'mise was not found on the PATH.',
    untrusted: 'The mise config is not trusted. Run `mise trust` in the project directory.',
    'timed-out': 'Listing mise tasks timed out.',
    failed: (detail?: string) => (detail ? `mise failed: ${detail}` : 'mise failed.'),
    unexpected: 'Unexpected output from mise.',
  },
} as const;
