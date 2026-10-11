/** Compact modal container for a single project settings session, reusing shared keyboard focus management. */
import { useId, useRef, type ReactElement } from 'react';
import type { Project } from '@shared/types';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { useProjectDefaultAgent } from '@renderer/hooks/useProjectDefaultAgent';
import { PROJECT_SETTINGS_COPY as COPY, PROJECT_SETTINGS_TESTIDS as TESTIDS, type ProjectSettingsTarget } from '@renderer/project-settings-contract';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { XIcon } from './shell-icons';

interface Props {
  readonly target: ProjectSettingsTarget;
  readonly onClose: () => void;
  readonly onSaved: (project: Project) => void;
}

/** Owns modal focus and dismissal; the App mounts this keyed by the immutable target ID. */
export function ProjectSettingsDialog({ target, onClose, onSaved }: Props): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const trap = useDialogFocus(panelRef);
  const { snapshot, choose, replaceCustomCommands, retry } = useProjectDefaultAgent(target, onSaved);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm" onClick={onClose}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      data-testid={TESTIDS.dialog}
      className="flex max-h-[calc(100dvh-24px)] w-full max-w-[480px] min-w-0 flex-col overflow-hidden rounded-xl border border-[--border] bg-[--panel-strong] text-[--text] shadow-2xl focus:outline-none"
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        trap(event);
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      }}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[--border] px-4 py-2">
        <h2 id={titleId} className="text-base font-semibold">{COPY.title}</h2>
        <button type="button" aria-label={COPY.close} onClick={onClose} data-testid={TESTIDS.close}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[--text-muted] hover:bg-[--surface-hover] hover:text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]">
          <XIcon />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <ProjectSettingsPanel snapshot={snapshot} onChoose={choose} onReplaceCustomCommands={replaceCustomCommands} onRetry={retry} />
      </div>
      <div className="flex shrink-0 justify-end border-t border-[--border] p-3">
        <button type="button" onClick={onClose} data-testid={TESTIDS.done}
          className="min-h-11 rounded-lg border border-[--border] px-5 text-sm hover:bg-[--surface-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]">{COPY.done}</button>
      </div>
    </div>
  </div>;
}
