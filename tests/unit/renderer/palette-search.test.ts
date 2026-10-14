/**
 * `searchPalette` builds the palette view from the providers: fixed group order with empty groups
 * dropped (AC6), list order on an empty query and match order within each group otherwise (AC7,
 * AC13), the 50/40 row caps (AC13, AC34), prefix modes (AC33, AC41, AC42, AC44), every empty-state
 * (AC14, AC36, AC38, AC41, AC42) and the flat row list the highlight indexes into (AC3). Also covers
 * `availableCommands` (AC12) and `stepHighlight` (AC3, AC14).
 */
import { describe, it, expect } from 'vitest';
import { availableCommands, searchPalette, stepHighlight } from '@renderer/palette-search';
import { parsePaletteQuery } from '@renderer/palette-query';
import {
  PALETTE_COPY,
  type PaletteCategory,
  type PaletteCommand,
  type PaletteFileEntry,
  type PaletteFilesState,
  type PaletteRow,
  type PaletteSearchInput,
  type PaletteView,
} from '@renderer/command-palette-contract';
import type { Project } from '@shared/types';

function project(id: number, name: string, path = `/work/${name}`): Project {
  return {
    id, rootId: 1, path, name, metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false, firstLaunchedAt: null, config: {} as Project['config'],
  };
}

function command(id: string, category: PaletteCategory, title: string, hint?: string): PaletteCommand {
  return { id, title, category, hint, run: () => undefined };
}

const PROJECTS = [project(3, 'zebra'), project(1, 'alpha-tools'), project(2, 'tools')];

const COMMANDS: PaletteCommand[] = [
  command('settings.general', 'Settings', 'Settings: General'),
  command('app.reload', 'App', 'Reload window'),
  command('go.files', 'Go', 'Go to files'),
  command('view.sidebar', 'View', 'Toggle sidebar', '⌘B'),
  command('go.shell', 'Go', 'Go to shell'),
  command('project.find', 'Project', 'Find file in project', '⌘P'),
];

const READY_FILES: PaletteFilesState = {
  status: 'ready',
  files: [
    { relPath: 'src/zeta.ts', name: 'zeta.ts' },
    { relPath: 'src/renderer/App.tsx', name: 'App.tsx' },
    { relPath: 'docs/app-notes.md', name: 'app-notes.md' },
  ],
  truncated: false,
};

function input(over: Partial<PaletteSearchInput> = {}): PaletteSearchInput {
  return { projects: PROJECTS, currentProjectId: null, commands: COMMANDS, files: READY_FILES, ...over };
}

function view(raw: string, over: Partial<PaletteSearchInput> = {}): PaletteView {
  return searchPalette(parsePaletteQuery(raw), input(over));
}

function label(row: PaletteRow): string {
  if (row.kind === 'project') return `p:${row.project.name}`;
  if (row.kind === 'command') return `c:${row.command.id}`;
  return `f:${row.file.relPath}`;
}

const groupIds = (v: PaletteView): string[] => v.groups.map((g) => g.id);

describe('searchPalette — normal mode', () => {
  it('orders groups projects, Go, Project, View, Shell, Theme, App, Settings and drops empty ones (AC6)', () => {
    const v = view('');
    expect(groupIds(v)).toEqual(['projects', 'Go', 'Project', 'View', 'App', 'Settings']);
    expect(v.groups.map((g) => g.title)).toEqual(['Projects', 'Go', 'Project', 'View', 'App', 'Settings']);
    expect(v.mode).toBe('all');
    expect(v.empty).toBeNull();
  });

  it('keeps projects:list order and command list order with an empty query (AC7)', () => {
    const v = view('');
    expect(v.groups[0]?.rows.map(label)).toEqual(['p:zebra', 'p:alpha-tools', 'p:tools']);
    expect(v.groups[1]?.rows.map(label)).toEqual(['c:go.files', 'c:go.shell']);
  });

  it('orders rows within a group by match quality (AC13)', () => {
    const v = view('tools');
    expect(v.groups[0]?.id).toBe('projects');
    expect(v.groups[0]?.rows.map(label)).toEqual(['p:tools', 'p:alpha-tools']);
  });

  it('keeps the fixed group order even when a later group matches better (AC13)', () => {
    const cmds = [command('go.x', 'Go', 'Go somewhere sidebarish'), command('view.sidebar', 'View', 'sidebar')];
    const v = view('sidebar', { commands: cmds, projects: [] });
    expect(groupIds(v)).toEqual(['Go', 'View']);
  });

  it('matches projects on path and commands on category and hint (AC13)', () => {
    expect(view('/work/zebra').rows.map(label)).toContain('p:zebra');
    expect(view('⌘B').rows.map(label)).toContain('c:view.sidebar');
    const settings = view('Settings', { projects: [] });
    expect(settings.rows.map(label)).toContain('c:settings.general');
  });

  it('flattens the groups into rows in display order, without headings (AC3)', () => {
    const v = view('');
    expect(v.rows).toEqual(v.groups.flatMap((g) => g.rows));
    expect(v.rows).toHaveLength(PROJECTS.length + COMMANDS.length);
  });

  it('flags only the current project (AC7)', () => {
    const v = view('', { currentProjectId: 1 });
    const flags = v.rows.flatMap((r) => (r.kind === 'project' ? [[r.project.id, r.current]] : []));
    expect(flags).toEqual([[3, false], [1, true], [2, false]]);
  });

  it('never lists files outside "@" mode, even when the file list is loaded (AC44)', () => {
    for (const raw of ['', 'app', '#', '>app']) {
      expect(view(raw).rows.some((r) => r.kind === 'file'), raw).toBe(false);
      expect(groupIds(view(raw)), raw).not.toContain('files');
    }
  });

  it('caps the rows at 50 in total, filling groups in order (AC13)', () => {
    const many = Array.from({ length: 45 }, (_, i) => project(i + 10, `proj-${i}`));
    const v = view('', { projects: many });
    expect(v.rows).toHaveLength(50);
    expect(v.groups[0]?.rows).toHaveLength(45);
    expect(v.groups.flatMap((g) => g.rows)).toHaveLength(50);
    expect(groupIds(v)).toEqual(['projects', 'Go', 'Project', 'View', 'App']);
  });

  it('hides the command groups when more than 50 projects fill the cap (AC13 limitation)', () => {
    const many = Array.from({ length: 60 }, (_, i) => project(i + 10, `proj-${i}`));
    const v = view('', { projects: many });
    expect(v.rows).toHaveLength(50);
    expect(groupIds(v)).toEqual(['projects']);
  });

  it('shows "No results" with the query when nothing matches (AC14)', () => {
    const v = view('qqqzzzxxx');
    expect(v.rows).toEqual([]);
    expect(v.groups).toEqual([]);
    expect(v.empty).toEqual({ kind: 'no-results', query: 'qqqzzzxxx' });
  });
});

describe('searchPalette — "#" projects mode (AC41)', () => {
  it('lists only projects, in list order, with nothing after "#"', () => {
    const v = view('#');
    expect(v.mode).toBe('projects');
    expect(groupIds(v)).toEqual(['projects']);
    expect(v.rows.map(label)).toEqual(['p:zebra', 'p:alpha-tools', 'p:tools']);
  });

  it('ranks projects like the normal-mode Projects group', () => {
    expect(view('#  tools').rows).toEqual(view('tools').groups[0]?.rows);
  });

  it('says no projects match, with the query', () => {
    expect(view('#qqqzzz').empty).toEqual({ kind: 'no-projects-match', query: 'qqqzzz' });
  });

  it('says there are no projects yet when the list is empty', () => {
    const v = view('#', { projects: [] });
    expect(v.rows).toEqual([]);
    expect(v.empty).toEqual({ kind: 'no-projects' });
    expect(view('#abc', { projects: [] }).empty).toEqual({ kind: 'no-projects' });
  });

  it('caps at 50 rows', () => {
    const many = Array.from({ length: 70 }, (_, i) => project(i + 10, `proj-${i}`));
    expect(view('#', { projects: many }).rows).toHaveLength(50);
  });
});

describe('searchPalette — ">" commands mode (AC42)', () => {
  it('lists only command and Settings groups in AC6 order with nothing after ">"', () => {
    const v = view('>');
    expect(v.mode).toBe('commands');
    expect(groupIds(v)).toEqual(['Go', 'Project', 'View', 'App', 'Settings']);
    expect(v.rows).toHaveLength(COMMANDS.length);
  });

  it('matches the text after ">" like normal mode, without projects', () => {
    const normal = view('sidebar', { projects: [] });
    expect(view('> sidebar').rows).toEqual(normal.rows);
    expect(view('>tools').rows.some((r) => r.kind === 'project')).toBe(false);
  });

  it('says no commands match, with the query', () => {
    expect(view('>qqqzzz').empty).toEqual({ kind: 'no-commands-match', query: 'qqqzzz' });
  });
});

describe('searchPalette — "@" files mode (AC33-AC38)', () => {
  it('lists files in source order under a single Files group with nothing after "@"', () => {
    const v = view('@');
    expect(v.mode).toBe('files');
    expect(groupIds(v)).toEqual(['files']);
    expect(v.groups[0]?.title).toBe(PALETTE_COPY.groupTitles.files);
    expect(v.rows.map(label)).toEqual(['f:src/zeta.ts', 'f:src/renderer/App.tsx', 'f:docs/app-notes.md']);
  });

  it('matches name and relative path, best first (AC34)', () => {
    expect(view('@App.tsx').rows.map(label)[0]).toBe('f:src/renderer/App.tsx');
    expect(view('@docs/').rows.map(label)).toContain('f:docs/app-notes.md');
    expect(view('@zeta').rows.map(label)).toEqual(['f:src/zeta.ts']);
  });

  it('caps at 40 rows (AC34)', () => {
    const files: PaletteFileEntry[] = Array.from({ length: 100 }, (_, i) => ({ relPath: `f${i}.ts`, name: `f${i}.ts` }));
    expect(view('@', { files: { status: 'ready', files, truncated: false } }).rows).toHaveLength(40);
  });

  it('reports a capped index only in files mode (AC34)', () => {
    const files: PaletteFilesState = { ...READY_FILES, truncated: true };
    expect(view('@', { files }).truncatedFiles).toBe(true);
    expect(view('', { files }).truncatedFiles).toBe(false);
    expect(view('@').truncatedFiles).toBe(false);
  });

  it.each([
    [{ status: 'no-project' }, { kind: 'files-no-project' }],
    [{ status: 'loading' }, { kind: 'files-loading' }],
    [{ status: 'idle' }, { kind: 'files-loading' }],
    [{ status: 'error' }, { kind: 'files-error' }],
  ] as const)('shows no rows and the %o empty state', (files, empty) => {
    const v = view('@abc', { files });
    expect(v.rows).toEqual([]);
    expect(v.groups).toEqual([]);
    expect(v.empty).toEqual(empty);
  });

  it('says no files match, with the query (AC38)', () => {
    expect(view('@ qqqzzz').empty).toEqual({ kind: 'no-files-match', query: 'qqqzzz' });
  });

  it('lists no projects or commands in files mode (AC33)', () => {
    expect(view('@tools').rows.every((r) => r.kind === 'file')).toBe(true);
  });
});

describe('availableCommands (AC12)', () => {
  const cmds = [command('a', 'App', 'A'), { ...command('b', 'Shell', 'B'), needsProject: true }];

  it('drops project-dependent commands when no project is selected', () => {
    expect(availableCommands(cmds, false).map((c) => c.id)).toEqual(['a']);
  });

  it('keeps every command when a project is selected', () => {
    expect(availableCommands(cmds, true).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('stepHighlight (AC3, AC14)', () => {
  it('moves down and up, stopping at the ends', () => {
    expect(stepHighlight('ArrowDown', 0, 3)).toEqual({ kind: 'move', index: 1 });
    expect(stepHighlight('ArrowDown', 2, 3)).toEqual({ kind: 'move', index: 2 });
    expect(stepHighlight('ArrowUp', 2, 3)).toEqual({ kind: 'move', index: 1 });
    expect(stepHighlight('ArrowUp', 0, 3)).toEqual({ kind: 'move', index: 0 });
  });

  it('stays on 0 with no rows', () => {
    expect(stepHighlight('ArrowDown', 0, 0)).toEqual({ kind: 'move', index: 0 });
    expect(stepHighlight('ArrowUp', 0, 0)).toEqual({ kind: 'move', index: 0 });
  });

  it('picks on Enter only when there are rows', () => {
    expect(stepHighlight('Enter', 1, 3)).toEqual({ kind: 'pick' });
    expect(stepHighlight('Enter', 0, 0)).toBeNull();
  });

  it('closes on Escape and ignores other keys', () => {
    expect(stepHighlight('Escape', 0, 0)).toEqual({ kind: 'close' });
    expect(stepHighlight('a', 0, 3)).toBeNull();
    expect(stepHighlight('Tab', 0, 3)).toBeNull();
  });
});
