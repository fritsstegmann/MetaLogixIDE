/**
 * The command palette's result list: a `listbox` of `group`s, each labelled by its visible heading,
 * holding `option` rows (AC3, AC20), followed by a polite live region that shows why the list is
 * empty (AC14, AC36, AC38, AC41, AC42). Options never take focus: the input keeps it and points at
 * the highlighted option with `aria-activedescendant`, whose fill is the focus indicator. Emits
 * `onHover(index)` and `onPick(index)` with indexes into `view.rows`.
 */
import type { ReactNode } from 'react';
import type { Root } from '@shared/types';
import { PALETTE_COPY, PALETTE_TESTIDS, type PaletteEmpty, type PaletteGroup, type PaletteRow, type PaletteView } from '@renderer/command-palette-contract';
import { CommandRow } from './CommandRow';
import { FileRow } from './FileRow';
import { ProjectRow } from './ProjectRow';

/** The DOM id of the option at `index`, shared by the list and the combobox's `aria-activedescendant`. */
export function optionId(idPrefix: string, index: number): string {
  return `${idPrefix}-option-${index}`;
}

/** The DOM id of the listbox, the target of the combobox's `aria-controls`. */
export function listboxId(idPrefix: string): string {
  return `${idPrefix}-listbox`;
}

/** The user-facing copy for an empty list. */
export function emptyText(empty: PaletteEmpty): string {
  const copy = PALETTE_COPY.empty;
  switch (empty.kind) {
    case 'no-results': return copy.noResults(empty.query);
    case 'no-projects-match': return copy.noProjectsMatch(empty.query);
    case 'no-projects': return copy.noProjects;
    case 'no-commands-match': return copy.noCommandsMatch(empty.query);
    case 'no-files-match': return copy.noFilesMatch(empty.query);
    case 'files-no-project': return copy.filesNoProject;
    case 'files-loading': return copy.filesLoading;
    case 'files-error': return copy.filesError;
  }
}

interface RowContentProps {
  readonly row: PaletteRow;
  readonly active: boolean;
  readonly aliveIds: ReadonlySet<number>;
  readonly rootsById: ReadonlyMap<number, Root>;
}

function RowContent({ row, active, aliveIds, rootsById }: RowContentProps): React.JSX.Element {
  if (row.kind === 'command') return <CommandRow command={row.command} />;
  if (row.kind === 'file') return <FileRow file={row.file} active={active} />;
  const { project } = row;
  return <ProjectRow project={project} root={rootsById.get(project.rootId)} current={row.current} active={active} alive={aliveIds.has(project.id)} />;
}

/** Project groups show their row count after the heading. */
function isProjectGroup(id: PaletteGroup['id']): boolean {
  return id === 'running' || id === 'projects';
}

function rowKey(row: PaletteRow): string {
  if (row.kind === 'command') return `c:${row.command.id}`;
  if (row.kind === 'file') return `f:${row.file.relPath}`;
  return `p:${row.project.id}`;
}

interface PaletteOptionProps {
  readonly id: string;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onPick: () => void;
  readonly children: ReactNode;
}

function PaletteOption({ id, active, onHover, onPick, children }: PaletteOptionProps): React.JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-testid={PALETTE_TESTIDS.option}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => { if (!active) onHover(); }}
      onClick={onPick}
      className={`mx-2 flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-[14px] ${
        active ? 'bg-[--modal-row-active] text-[--modal-row-active-text]' : 'text-[--text]'
      }`}
    >
      {children}
    </div>
  );
}

interface PaletteListProps {
  readonly view: PaletteView;
  readonly activeIndex: number;
  readonly idPrefix: string;
  readonly aliveIds: ReadonlySet<number>;
  readonly rootsById: ReadonlyMap<number, Root>;
  readonly onHover: (index: number) => void;
  readonly onPick: (index: number) => void;
}

export function PaletteList({ view, activeIndex, idPrefix, aliveIds, rootsById, onHover, onPick }: PaletteListProps): React.JSX.Element {
  const starts = view.groups.map((_, g) => view.groups.slice(0, g).reduce((n, prev) => n + prev.rows.length, 0));
  return (
    <>
      <div
        role="listbox"
        id={listboxId(idPrefix)}
        aria-label={PALETTE_COPY.inputLabel}
        data-testid={PALETTE_TESTIDS.listbox}
        className="max-h-[min(460px,60vh)] overflow-y-auto pb-2"
      >
        {view.groups.map((group, g) => (
          <div key={group.id} role="group" aria-labelledby={`${idPrefix}-group-${group.id}`} data-testid={PALETTE_TESTIDS.group}>
            <div className="flex items-baseline gap-2 px-[18px] pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[--modal-text-muted]">
              <span id={`${idPrefix}-group-${group.id}`}>{group.title}</span>
              {isProjectGroup(group.id) && <span aria-hidden="true" className="tabular-nums">{group.rows.length}</span>}
            </div>
            {group.rows.map((row, r) => {
              const index = (starts[g] ?? 0) + r;
              return (
                <PaletteOption
                  key={rowKey(row)}
                  id={optionId(idPrefix, index)}
                  active={index === activeIndex}
                  onHover={() => onHover(index)}
                  onPick={() => onPick(index)}
                >
                  <RowContent row={row} active={index === activeIndex} aliveIds={aliveIds} rootsById={rootsById} />
                </PaletteOption>
              );
            })}
          </div>
        ))}
      </div>
      <div role="status" aria-live="polite">
        {view.empty && (
          <div data-testid={PALETTE_TESTIDS.empty} className="px-4 py-6 text-center text-[13px] text-[--modal-text-muted]">
            {emptyText(view.empty)}
          </div>
        )}
      </div>
    </>
  );
}
