import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import { entryKey, type DiffEntry, type DiffGroupView } from '@renderer/diff/diff-selection';
import { gitStatusTextClass } from '@renderer/git-status-style';

interface Props {
  groups: DiffGroupView[];
  selectedKey: string | null;
  onSelect: (entry: DiffEntry) => void;
}

interface RowProps {
  entry: DiffEntry;
  selected: boolean;
  onSelect: (entry: DiffEntry) => void;
}

function rowTitle(entry: DiffEntry): string {
  return entry.origPath === undefined ? entry.path : `${entry.path}\n${DIFF_COPY.renamedFrom(entry.origPath)}`;
}

function DiffFileRow({ entry, selected, onSelect }: RowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(entry)}
        title={rowTitle(entry)}
        aria-current={selected ? 'true' : undefined}
        data-testid={DIFF_TESTIDS.row}
        data-path={entry.path}
        data-group={entry.group}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[--accent] ${
          selected ? 'bg-[--accent]/15 text-[--text]' : 'text-[--text-muted] hover:bg-[--panel-strong] hover:text-[--text]'
        }`}
      >
        <span className={`w-3 shrink-0 text-center text-[10px] ${gitStatusTextClass(entry.status)}`} data-testid={DIFF_TESTIDS.rowStatus}>
          {entry.status}
        </span>
        <span className="truncate min-w-0">{entry.path}</span>
      </button>
    </li>
  );
}

/** Grouped list of changed files (Staged, Changes, Untracked) with one selectable row per entry; `onSelect` fires with the clicked entry (spec AC7, AC8, AC11, AC13, AC19). */
export function DiffFileList({ groups, selectedKey, onSelect }: Props) {
  return (
    <ul className="py-1" aria-label={DIFF_COPY.listLabel} data-testid={DIFF_TESTIDS.list}>
      {groups.map(({ group, entries }) => (
        <li key={group} data-testid={DIFF_TESTIDS.group} data-group={group}>
          <h3 id={`diff-group-${group}`} className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-[--text-muted]">
            {DIFF_COPY.group[group]} <span className="opacity-60">({entries.length})</span>
          </h3>
          <ul aria-labelledby={`diff-group-${group}`}>
            {entries.map((entry) => {
              const key = entryKey(entry);
              return <DiffFileRow key={key} entry={entry} selected={key === selectedKey} onSelect={onSelect} />;
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
