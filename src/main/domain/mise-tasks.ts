/**
 * mise task discovery for the Tasks panel: the root-only marker gate (spec AC4, AC5), a defensive parser
 * of `mise tasks ls --json` output (AC1–AC3, security S1, S2), and the mapping of a listing outcome to
 * tasks or a per-source notice (AC10–AC13). A failed listing yields no tasks at all, which is what keeps
 * the panel from ever running a task from a config mise reported as not trusted (AC21, AC22).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskDef, TaskNotice } from '@shared/tasks-contract';
import type { MiseLister, MiseListResult } from './mise-cli';

/** Config files and task directories, relative to the project root, whose presence means the project uses mise. */
export const MISE_MARKERS: readonly string[] = [
  'mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.config/mise.toml', '.config/mise/config.toml',
  'mise/config.toml', '.mise/config.toml',
  'mise-tasks', '.mise-tasks', 'mise/tasks', '.mise/tasks', '.config/mise/tasks',
];

const DETAIL_MAX = 200;
const LEVEL_PREFIX = /^mise\s+(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+/;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export interface MiseDiscovery { tasks: TaskDef[]; notice?: TaskNotice }

/** True when the project root itself holds any `MISE_MARKERS` entry; parent directories are never checked. */
export function hasMiseMarker(root: string, exists: (path: string) => boolean = existsSync): boolean {
  return MISE_MARKERS.some((marker) => exists(join(root, marker)));
}

function isListable(entry: Record<string, unknown>): boolean {
  const name = entry.name as string;
  // A leading `-` would be parsed by `mise run` as its own flag (`-C` is `--cd`), and `--` does not escape it (S1).
  return entry.hide !== true && entry.global !== true && name !== '' && !name.startsWith('-');
}

function toTask(entry: Record<string, unknown>): TaskDef {
  const name = entry.name as string;
  const task: TaskDef = { id: `mise:${name}`, source: 'mise', name, command: ['mise', 'run', name] };
  if (typeof entry.description === 'string' && entry.description !== '') task.description = entry.description;
  return task;
}

function isTaskEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).name === 'string';
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Parse `mise tasks ls --json` stdout into tasks, in mise's order, dropping hidden, global, empty-named and
 * flag-like (`-…`) entries. Returns null when stdout is not a JSON array whose every element is an object
 * with a string `name`; a partial list is never returned. Only `name`, `description`, `hide` and `global` are read.
 */
export function parseMiseTasks(stdout: string): TaskDef[] | null {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed) || !parsed.every(isTaskEntry)) return null;
  return parsed.filter(isListable).map(toTask);
}

/**
 * The user-facing reason for a failed listing: the first `mise ERROR` line of stderr, else its first
 * non-empty line, with the level prefix, ANSI codes and control characters removed and capped at 200
 * characters. Undefined when stderr has no visible text.
 */
export function miseFailureDetail(stderr: string): string | undefined {
  const lines = stderr.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith('mise ERROR')) ?? lines[0];
  return line?.replace(LEVEL_PREFIX, '').slice(0, DETAIL_MAX) || undefined;
}

function failureNotice(stderr: string): TaskNotice {
  if (stderr.includes('not trusted')) return { source: 'mise', kind: 'untrusted' };
  const detail = miseFailureDetail(stderr);
  return detail ? { source: 'mise', kind: 'failed', detail } : { source: 'mise', kind: 'failed' };
}

function fromListResult(result: MiseListResult): MiseDiscovery {
  if (result.kind === 'failed') return { tasks: [], notice: failureNotice(result.stderr) };
  if (result.kind !== 'ok') return { tasks: [], notice: { source: 'mise', kind: result.kind } };
  const tasks = parseMiseTasks(result.stdout);
  return tasks ? { tasks } : { tasks: [], notice: { source: 'mise', kind: 'unexpected' } };
}

/**
 * Discover the mise tasks of `root`, listing them with `list` in `root` with `env` only when the root has a
 * mise marker. Resolves either tasks with no notice, or no tasks with one notice saying why listing failed.
 */
export async function discoverMiseTasks(root: string, env: NodeJS.ProcessEnv, list: MiseLister): Promise<MiseDiscovery> {
  if (!hasMiseMarker(root)) return { tasks: [] };
  return fromListResult(await list(root, env));
}
