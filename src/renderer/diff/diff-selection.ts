/**
 * Pure list and selection logic for the Diff tab: groups the `git:panel-status` lists into
 * Staged / Changes / Untracked, keeps a selection across refreshes only within its group,
 * maps an entry to its `git:diff-sides` request, and derives the tab-label count
 * (spec AC7, AC9, AC10, AC12, AC19, AC23, AC25, AC34).
 */
import type { GitChangeEntry, GitDiffKind, GitFileStatus } from '@shared/ipc-contract';

export type DiffGroup = GitDiffKind;

export interface DiffEntry {
  group: DiffGroup;
  path: string;
  status: GitFileStatus;
  origPath?: string;
}

export interface DiffGroupView {
  group: DiffGroup;
  entries: DiffEntry[];
}

export interface ChangeLists {
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  untracked: string[];
}

export interface SidesRequest {
  kind: GitDiffKind;
  path: string;
  origPath?: string;
}

function toEntry(group: DiffGroup, change: GitChangeEntry): DiffEntry {
  const entry: DiffEntry = { group, path: change.path, status: change.status };
  if (change.origPath !== undefined) entry.origPath = change.origPath;
  return entry;
}

/** Non-empty groups in display order (staged, unstaged, untracked); untracked paths become status `?` entries. */
export function groupChanges(lists: ChangeLists): DiffGroupView[] {
  const groups: DiffGroupView[] = [
    { group: 'staged', entries: lists.staged.map((c) => toEntry('staged', c)) },
    { group: 'unstaged', entries: lists.unstaged.map((c) => toEntry('unstaged', c)) },
    { group: 'untracked', entries: lists.untracked.map((path) => toEntry('untracked', { path, status: '?' })) },
  ];
  return groups.filter((g) => g.entries.length > 0);
}

/** Every listed row in display order; a path in two groups appears twice. */
export function flattenChanges(lists: ChangeLists): DiffEntry[] {
  return groupChanges(lists).flatMap((g) => g.entries);
}

/** Identity of a row: the same path in another group is a different row. */
export function entryKey(entry: DiffEntry): string {
  return `${entry.group}:${entry.path}`;
}

/** The entry to select after a refresh: the same group-and-path if still listed, else the first entry, else null. */
export function reconcileSelection(selectedKey: string | null, entries: DiffEntry[]): DiffEntry | null {
  const kept = selectedKey === null ? undefined : entries.find((e) => entryKey(e) === selectedKey);
  return kept ?? entries[0] ?? null;
}

/** The `git:diff-sides` request fields (without projectId) for one entry. */
export function sidesRequestFor(entry: DiffEntry): SidesRequest {
  const request: SidesRequest = { kind: entry.group, path: entry.path };
  if (entry.origPath !== undefined) request.origPath = entry.origPath;
  return request;
}

/** Unique changed paths for the Diff tab label, from the app-wide `git:status` poll; null when there is nothing to show. */
export function diffTabCount(git: { isRepo: boolean; files: Record<string, GitFileStatus> }): number | null {
  const n = Object.keys(git.files).length;
  return git.isRepo && n > 0 ? n : null;
}
