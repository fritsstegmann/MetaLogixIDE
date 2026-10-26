import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '@shared/types';
import type { PrimarySessionInspection } from '@shared/unload-session-contract';
import { api } from '@renderer/api';
import { consentRisk, needsFreshConsent, type SessionRisk } from '@renderer/unload-session';
import { UNLOAD_SESSION_COPY as COPY, UNLOAD_SESSION_TESTIDS as IDS } from '@renderer/unload-session-copy';
import { useShellAgentState } from '@renderer/hooks/useAgentStates';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { ModalFrame } from './ModalFrame';

type Target = Pick<Project, 'id' | 'name'>;
/** Distinguishes a live inspected generation from an unreadable, replaced or exited session. */
export type UnloadSessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly inspection: Extract<PrimarySessionInspection, { kind: 'live' }>; readonly consent: SessionRisk; readonly error: string | null }
  | { readonly kind: 'pending'; readonly inspection: Extract<PrimarySessionInspection, { kind: 'live' }>; readonly consent: SessionRisk }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'replaced' };

/** Inspects on opening and pins each confirmation to the inspected project and launch generation. */
export function useUnloadSessionWorkflow(
  target: Target,
  visible: boolean,
  signal: 'idle' | 'busy' | 'blocked',
  onClose: () => void,
  onStopped: () => void,
): { readonly state: UnloadSessionState; readonly risk: SessionRisk; readonly confirm: () => Promise<void>; readonly retry: () => Promise<void> } {
  const [state, setState] = useState<UnloadSessionState>({ kind: 'loading' });
  const pending = useRef(false);
  const active = useRef(true);
  const visibleRef = useRef(visible);
  const signalRef = useRef(signal);
  visibleRef.current = visible;
  signalRef.current = signal;

  useEffect(() => {
    active.current = true;
    void api.invoke('shells:inspect-primary', { projectId: target.id }).then((inspection) => {
      if (!active.current) return;
      if (inspection.kind === 'gone') { setState({ kind: 'gone' }); return; }
      setState({ kind: 'ready', inspection, consent: consentRisk(inspection, visibleRef.current), error: null });
    }).catch(() => { if (active.current) setState({ kind: 'error', message: COPY.inspectionFailed }); });
    return () => { active.current = false; };
  }, [target.id]);

  const inspection = state.kind === 'ready' || state.kind === 'pending' ? state.inspection : { kind: 'gone' as const };
  const reportedState = inspection.kind === 'live' && (signal === 'busy' || signal === 'blocked') && inspection.agent !== null
    ? signal : inspection.kind === 'live' ? inspection.state : null;
  const risk = consentRisk(inspection.kind === 'live' ? { ...inspection, state: reportedState } : inspection, visible);

  async function retry(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setState({ kind: 'loading' });
    try {
      const next = await api.invoke('shells:inspect-primary', { projectId: target.id });
      if (!active.current) return;
      if (next.kind === 'gone') setState({ kind: 'gone' });
      else setState({ kind: 'ready', inspection: next, consent: consentRisk(next, visibleRef.current), error: null });
    } catch {
      if (active.current) setState({ kind: 'error', message: COPY.inspectionFailed });
    } finally { pending.current = false; }
  }

  async function confirm(): Promise<void> {
    if (state.kind !== 'ready' || pending.current) return;
    pending.current = true;
    setState({ kind: 'pending', inspection: state.inspection, consent: state.consent });
    try {
      const next = await api.invoke('shells:inspect-primary', { projectId: target.id });
      if (!active.current) return;
      if (next.kind === 'gone') { setState({ kind: 'gone' }); return; }
      if (next.generation !== state.inspection.generation) { setState({ kind: 'replaced' }); return; }
      const nextRisk = consentRisk(next, visibleRef.current);
      const currentRisk = {
        work: nextRisk.work || (next.agent !== null && signalRef.current !== 'idle'),
        input: nextRisk.input || (next.agent !== null && signalRef.current === 'blocked'),
        visible: nextRisk.visible,
      };
      if (needsFreshConsent(state.consent, currentRisk)) {
        setState({ kind: 'ready', inspection: next, consent: currentRisk, error: COPY.escalated });
        return;
      }
      const outcome = await api.invoke('shells:stop-primary', {
        projectId: target.id, generation: state.inspection.generation,
        acknowledgedWorkRisk: currentRisk.work,
      });
      if (!active.current) return;
      if (outcome.kind === 'stopped') { onStopped(); onClose(); }
      else if (outcome.kind === 'escalated') {
        const refreshed = await api.invoke('shells:inspect-primary', { projectId: target.id });
        if (!active.current) return;
        if (refreshed.kind === 'gone') { setState({ kind: 'gone' }); return; }
        if (refreshed.generation !== state.inspection.generation) { setState({ kind: 'replaced' }); return; }
        setState({ kind: 'ready', inspection: refreshed, consent: consentRisk(refreshed, visibleRef.current), error: COPY.escalated });
      } else setState({ kind: outcome.kind });
    } catch {
      if (active.current) setState({ kind: 'error', message: COPY.stopFailed });
    } finally { pending.current = false; }
  }

  return { state, risk, confirm, retry };
}

interface ViewProps {
  readonly name: string;
  readonly state: UnloadSessionState;
  readonly risk: SessionRisk;
  readonly onKeep: () => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly panelRef: React.RefObject<HTMLElement>;
  readonly keepRef: React.RefObject<HTMLButtonElement>;
}

/** Modal content names the exact local target, protects the safe exit, and announces changed risk. */
export function UnloadSessionDialogView({ name, state, risk, onKeep, onConfirm, onRetry, onKeyDown, panelRef, keepRef }: ViewProps): React.JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const button = 'min-h-11 px-4 rounded-lg text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';
  const error = state.kind === 'error' ? state.message : state.kind === 'ready' ? state.error : null;
  return (
    <ModalFrame testId={IDS.dialog} tier="modal" motion="none" layerClassName="flex items-center justify-center p-4" onDismiss={state.kind === 'pending' ? undefined : onKeep}>
      <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
        aria-busy={state.kind === 'pending'} tabIndex={-1} onKeyDown={onKeyDown}
        className="modal-sheet w-full min-w-0 max-w-md max-h-full overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-[--accent] p-5 space-y-4 text-base text-[--text]">
        <h2 id={titleId} className="font-semibold">{COPY.title}</h2>
        <p id={descriptionId} data-testid={IDS.description} className="break-words">{COPY.consequence(name)} Only shell 0 will stop.</p>
        {(risk.work || risk.visible) && <div role="alert" data-testid={IDS.warning} className="text-[--danger] space-y-2">
          {risk.work && <p>{risk.input ? COPY.inputWarning : COPY.workWarning}</p>}
          {risk.visible && <p>{COPY.visibleWarning}</p>}
        </div>}
        {state.kind === 'gone' && <p role="status" data-testid={IDS.error}>{COPY.ended}</p>}
        {state.kind === 'replaced' && <p role="alert" data-testid={IDS.error}>{COPY.replaced}</p>}
        {error && <p role="alert" data-testid={IDS.error} className="text-[--danger]">{error}</p>}
        {state.kind === 'loading' && <p role="status">Checking session…</p>}
        {state.kind === 'pending' && <p role="status">Unloading session…</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {(state.kind === 'error' || state.kind === 'replaced') && <button type="button" data-testid={IDS.retry} onClick={onRetry} className={button}>Retry</button>}
          {(state.kind === 'ready' || state.kind === 'pending') && <button type="button" data-testid={IDS.unload} onClick={onConfirm}
            disabled={state.kind === 'pending'} className={`${button} text-[--danger] disabled:opacity-50`}>{COPY.unload}</button>}
          <button ref={keepRef} type="button" data-testid={IDS.keep} onClick={onKeep} disabled={state.kind === 'pending'}
            className={`${button} bg-[--panel-strong] disabled:opacity-50`}>{COPY.keep}</button>
        </div>
      </section>
    </ModalFrame>
  );
}

interface Props {
  readonly project: Target;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onStopped: () => void;
}

/** Accessible confirmation for exactly one local project's existing shell-zero launch. */
export function UnloadSessionDialog({ project, visible, onClose, onStopped }: Props): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const trapFocus = useDialogFocus(panelRef);
  const signal = useShellAgentState(project.id, 0).state;
  const workflow = useUnloadSessionWorkflow(project, visible, signal, onClose, onStopped);
  useEffect(() => {
    const background = document.querySelector<HTMLElement>('[data-chrome-root]');
    const wasInert = background?.inert;
    if (background) background.inert = true;
    keepRef.current?.focus();
    return () => { if (background) background.inert = wasInert ?? false; };
  }, []);
  useEffect(() => {
    if (workflow.state.kind === 'pending') panelRef.current?.focus();
  }, [workflow.state.kind]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    trapFocus(event);
    if (event.key === 'Escape' && workflow.state.kind !== 'pending') { event.stopPropagation(); onClose(); }
  };
  return createPortal(<UnloadSessionDialogView name={project.name} state={workflow.state} risk={workflow.risk}
    onKeep={onClose} onConfirm={() => { void workflow.confirm(); }} onRetry={() => { void workflow.retry(); }}
    onKeyDown={onKeyDown} panelRef={panelRef} keepRef={keepRef} />, document.body);
}
