import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskDef, TasksDiscovery } from '@shared/tasks-contract';
import type { MiseLister } from './mise-cli';
import { discoverMiseTasks } from './mise-tasks';

export type { TaskDef };

/** What mise discovery needs from the caller: the spawn env tasks run with, and the injected lister. */
export interface MiseDeps { env: NodeJS.ProcessEnv; listMise: MiseLister }

/**
 * Discover runnable tasks for a project's root directory. Detects:
 *   - package.json → every entry under "scripts", run as `<pm> run <name>`
 *     (pm auto-picked: pnpm if pnpm-lock.yaml, yarn if yarn.lock, else npm)
 *   - Makefile → every "target:" (very lightweight regex; enough for the
 *     "list my targets" pane, not a full make parser)
 *   - docker-compose.yml / compose.yaml → one "up <service>" per service
 *     found under services:. We match on top-level 2-space-indented keys
 *     under a `services:` header — good enough for hand-written composes.
 * The list is intentionally forgiving: parse errors on one source shouldn't
 * hide the others.
 */
export function discoverTasks(projectPath: string): TaskDef[] {
  const out: TaskDef[] = [];

  // ─── package.json ────────────────────────────────────────────────
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const pm = existsSync(join(projectPath, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(projectPath, 'yarn.lock')) ? 'yarn'
        : existsSync(join(projectPath, 'bun.lockb')) ? 'bun'
        : 'npm';
      for (const [name, script] of Object.entries(scripts)) {
        out.push({
          id: `npm:${name}`,
          source: 'npm',
          name,
          command: [pm, 'run', name],
          description: script.length > 80 ? `${script.slice(0, 80)}…` : script,
        });
      }
    } catch { /* ignore malformed package.json */ }
  }

  // ─── Makefile ───────────────────────────────────────────────────
  const mkPath = join(projectPath, 'Makefile');
  if (existsSync(mkPath)) {
    try {
      const src = readFileSync(mkPath, 'utf8');
      // A "target" line: alphanum/dash/underscore/dot, optional deps, ':'
      // at the end (but not '=', which would be a variable assignment).
      const re = /^([A-Za-z0-9_.\-]+)\s*:[^=]/gm;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const name = m[1]!;
        if (seen.has(name)) continue;
        // Skip `.PHONY` and other special targets.
        if (name.startsWith('.')) continue;
        seen.add(name);
        out.push({
          id: `make:${name}`,
          source: 'make',
          name,
          command: ['make', name],
        });
      }
    } catch { /* ignore */ }
  }

  // ─── docker compose ─────────────────────────────────────────────
  for (const composeName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const cPath = join(projectPath, composeName);
    if (!existsSync(cPath)) continue;
    try {
      const src = readFileSync(cPath, 'utf8');
      // Very naive parse: find `services:` line, then take every 2-space
      // indented `key:` under it until we hit a top-level key.
      const lines = src.split(/\r?\n/);
      let inServices = false;
      const seen = new Set<string>();
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (/^services:\s*$/.test(line)) { inServices = true; continue; }
        if (inServices) {
          // Top-level key (no indent) ends the services block.
          if (/^\S/.test(line) && line.trim().length > 0) { inServices = false; continue; }
          const m = /^\s{2}([A-Za-z0-9_.\-]+):\s*$/.exec(line);
          if (m && !seen.has(m[1]!)) {
            seen.add(m[1]!);
            out.push({
              id: `compose:${m[1]}`,
              source: 'compose',
              name: `up ${m[1]}`,
              command: ['docker', 'compose', 'up', m[1]!],
              description: `${composeName} · service`,
            });
          }
        }
      }
    } catch { /* ignore */ }
    break; // only pick the first compose file we found
  }

  return out;
}

/**
 * Every task of a project: `discoverTasks`' npm, make and compose tasks unchanged and in their order,
 * followed by its mise tasks. A failed mise listing never hides the other sources; it adds one notice.
 */
export async function discoverAllTasks(projectPath: string, deps: MiseDeps): Promise<TasksDiscovery> {
  const mise = await discoverMiseTasks(projectPath, deps.env, deps.listMise);
  return { tasks: [...discoverTasks(projectPath), ...mise.tasks], notices: mise.notice ? [mise.notice] : [] };
}
