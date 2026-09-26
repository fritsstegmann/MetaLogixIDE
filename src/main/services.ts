import type { Database } from 'better-sqlite3';
import { openDb } from './db/connection';
import { runMigrations } from './db/migrator';
import { RootsRepo } from './repos/roots-repo';
import { ProjectsRepo } from './repos/projects-repo';
import { ShellsRepo } from './repos/shells-repo';
import { SettingsRepo } from './repos/settings-repo';
import { PromptsRepo } from './repos/prompts-repo';
import { PtyManager } from './pty/manager';
import { RootWatcher } from './domain/watcher';
import { MetaprojectClient } from './metaproject/client';
import { applyClaudePermissionMode } from './domain/claude-permission-mode';
import { isClaudePermissionMode } from '@shared/claude-permission-mode';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Services {
  db: Database;
  roots: RootsRepo;
  projects: ProjectsRepo;
  shells: ShellsRepo;
  settings: SettingsRepo;
  prompts: PromptsRepo;
  ptyManager: PtyManager;
  watcher: RootWatcher;
  metaproject: MetaprojectClient;
  homeDir: string;
  migrationsDir: string;
}

/**
 * Test/CI hook: `METAIDE_CLAUDE_PERMISSION_MODE` ('auto' | 'bypass') lets an
 * E2E spec or dev run skip the first-launch permission-mode modal. An
 * invalid value fails startup loudly rather than silently picking a mode.
 * Runs once, after `seedDefaults()` (so `METAIDE_DEFAULT_LAUNCH_*` overrides
 * are already the effective launch commands it would rewrite), and only
 * takes effect when no mode has been chosen yet — an install that already
 * has a stored choice is never overridden.
 */
function applyPermissionModeEnvOverride(settings: SettingsRepo): void {
  const raw = process.env.METAIDE_CLAUDE_PERMISSION_MODE;
  if (raw === undefined) return;
  if (!isClaudePermissionMode(raw)) {
    throw new Error(`METAIDE_CLAUDE_PERMISSION_MODE must be 'auto' or 'bypass', got: ${JSON.stringify(raw)}`);
  }
  if (settings.get('claude_permission_mode') !== null) return;
  applyClaudePermissionMode(settings, raw);
}

export function buildServices(opts: { dbPath?: string; migrationsDir?: string } = {}): Services {
  const home = homedir();
  const dbPath = opts.dbPath ?? join(home, '.metaide', 'metaide.db');
  const migrationsDir = opts.migrationsDir ?? resolve(process.cwd(), 'migrations');
  const db = openDb(dbPath);
  runMigrations(db, migrationsDir);
  const settings = new SettingsRepo(db);
  settings.seedDefaults();
  applyPermissionModeEnvOverride(settings);
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const shells = new ShellsRepo(db);
  const prompts = new PromptsRepo(db);
  const ptyManager = new PtyManager();
  const watcher = new RootWatcher({ cap: settings.get('max_watched_paths') });
  const metaproject = new MetaprojectClient();
  return { db, roots, projects, shells, settings, prompts, ptyManager, watcher, metaproject, homeDir: home, migrationsDir };
}
