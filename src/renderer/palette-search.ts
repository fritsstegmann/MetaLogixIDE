/**
 * Palette search: turns the parsed query and every provider's items into the `PaletteView` the
 * palette renders. The mode picks the providers (normal: projects, commands and Settings; "#":
 * projects; ">": commands and Settings; "@": files). Each provider is fuzzy-matched with fuse.js;
 * groups keep the fixed `GROUP_ORDER` with empty ones dropped, rows keep list order on an empty
 * query and match order otherwise, and the total is capped (50 rows, 40 in files mode). Pure; the
 * fuse indexes are cached per source array so a keystroke does not rebuild them.
 */
import Fuse, { type IFuseOptions } from 'fuse.js';
import {
  GROUP_ORDER,
  PALETTE_COPY,
  PALETTE_FILE_CAP,
  PALETTE_ROW_CAP,
  type PaletteCommand,
  type PaletteEmpty,
  type PaletteFileEntry,
  type PaletteGroup,
  type PaletteGroupId,
  type PaletteRow,
  type PaletteSearchInput,
  type PaletteView,
  type ParsedPaletteQuery,
  type SearchPalette,
} from '@renderer/command-palette-contract';
import type { Project } from '@shared/types';

const MATCH = { threshold: 0.4, ignoreLocation: true } as const;

function cachedMatcher<T>(options: IFuseOptions<T>): (items: readonly T[], text: string) => readonly T[] {
  const cache = new WeakMap<readonly T[], Fuse<T>>();
  return (items, text) => {
    if (!text) return items;
    let fuse = cache.get(items);
    if (!fuse) {
      fuse = new Fuse(items, options);
      cache.set(items, fuse);
    }
    return fuse.search(text).map((r) => r.item);
  };
}

const matchProjects = cachedMatcher<Project>({ keys: ['name', 'path'], ...MATCH });
const matchCommands = cachedMatcher<PaletteCommand>({ keys: ['title', 'category', 'hint'], ...MATCH });
const matchFiles = cachedMatcher<PaletteFileEntry>({ keys: ['name', 'relPath'], ...MATCH });

function group(id: PaletteGroupId, rows: readonly PaletteRow[]): PaletteGroup {
  return { id, title: PALETTE_COPY.groupTitles[id], rows };
}

/** Keeps `GROUP_ORDER`, drops empty groups and trims rows so the total stays within `cap`. */
function capGroups(groups: readonly PaletteGroup[], cap: number): PaletteGroup[] {
  const out: PaletteGroup[] = [];
  let left = cap;
  for (const g of groups) {
    const rows = g.rows.slice(0, left);
    if (rows.length > 0) out.push({ ...g, rows });
    left -= rows.length;
  }
  return out;
}

function projectGroup(text: string, input: PaletteSearchInput): PaletteGroup {
  const rows = matchProjects(input.projects, text).map(
    (project): PaletteRow => ({ kind: 'project', project, current: project.id === input.currentProjectId }),
  );
  return group('projects', rows);
}

function commandGroups(text: string, input: PaletteSearchInput): PaletteGroup[] {
  const matched = matchCommands(input.commands, text);
  return GROUP_ORDER.filter((id) => id !== 'projects').map((id) =>
    group(id, matched.filter((c) => c.category === id).map((command): PaletteRow => ({ kind: 'command', command }))),
  );
}

function view(parsed: ParsedPaletteQuery, groups: PaletteGroup[], empty: PaletteEmpty, truncatedFiles = false): PaletteView {
  const rows = groups.flatMap((g) => g.rows);
  return { mode: parsed.mode, groups, rows, empty: rows.length > 0 ? null : empty, truncatedFiles };
}

function filesView(parsed: ParsedPaletteQuery, input: PaletteSearchInput): PaletteView {
  const { files } = input;
  if (files.status === 'no-project') return view(parsed, [], { kind: 'files-no-project' });
  if (files.status === 'error') return view(parsed, [], { kind: 'files-error' });
  if (files.status !== 'ready') return view(parsed, [], { kind: 'files-loading' });
  const rows = matchFiles(files.files, parsed.text).map((file): PaletteRow => ({ kind: 'file', file }));
  const groups = capGroups([group('files', rows)], PALETTE_FILE_CAP);
  return view(parsed, groups, { kind: 'no-files-match', query: parsed.text }, files.truncated);
}

export const searchPalette: SearchPalette = (parsed, input) => {
  const { mode, text } = parsed;
  if (mode === 'files') return filesView(parsed, input);
  if (mode === 'projects') {
    const empty: PaletteEmpty = input.projects.length === 0 ? { kind: 'no-projects' } : { kind: 'no-projects-match', query: text };
    return view(parsed, capGroups([projectGroup(text, input)], PALETTE_ROW_CAP), empty);
  }
  if (mode === 'commands') {
    return view(parsed, capGroups(commandGroups(text, input), PALETTE_ROW_CAP), { kind: 'no-commands-match', query: text });
  }
  const groups = [projectGroup(text, input), ...commandGroups(text, input)];
  return view(parsed, capGroups(groups, PALETTE_ROW_CAP), { kind: 'no-results', query: text });
};

export type HighlightStep = { readonly kind: 'move'; readonly index: number } | { readonly kind: 'pick' } | { readonly kind: 'close' };

/**
 * What a key pressed in the palette input does to the highlight over `count` flat rows: arrows move
 * it (stopping at the ends), Enter picks only when there is a row (AC14), Escape closes, anything
 * else is left to the input (`null`).
 */
export function stepHighlight(key: string, active: number, count: number): HighlightStep | null {
  const last = Math.max(count - 1, 0);
  if (key === 'ArrowDown') return { kind: 'move', index: Math.min(active + 1, last) };
  if (key === 'ArrowUp') return { kind: 'move', index: Math.max(active - 1, 0) };
  if (key === 'Enter') return count > 0 ? { kind: 'pick' } : null;
  if (key === 'Escape') return { kind: 'close' };
  return null;
}
