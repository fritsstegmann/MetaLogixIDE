/** Fleet terminals share local shell chrome while PTY control stays on the linked machine. */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { clampRatio, SPLIT_RATIO_DEFAULT } from '@renderer/split-ratio';
import { SPLIT_TESTIDS } from '@renderer/split-copy';
import { shellChipLabel, stripShells } from '@renderer/shell-label';
import type { FleetShell } from '@shared/fleet-contract';
import { RemoteTerminalPane, type RemotePaneStatus, type RemoteTerminalPaneControl } from './RemoteTerminalPane';
import { StatusDot } from './StatusDot';
import { ShellTabsBar, type RemoteShellMenu, type ShellTabsBarItem } from './ShellTabsBar';
import { SplitGutter } from './SplitGutter';
import { SplitPaneHeader } from './SplitPaneHeader';
import { XIcon } from './shell-icons';
import type { RemoteProjectSelection } from './Sidebar';

const BUTTON = 'h-7 rounded-md px-2 text-xs text-[--text-muted] hover:bg-[--panel-strong] hover:text-[--text] focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-40';
const REMOTE_LAUNCH_ERRORS = [
  'Choose a Claude permission mode on the remote machine first',
  'Claude is unavailable on the remote machine',
  'Remote shell limit reached; unpin a shell or raise the cap',
  'Remote project folder is unavailable',
] as const;
const PANE_CARD = 'rounded-[10px] bg-[--surface-pane]';
type Session = { kind: 'starting' } | { kind: 'connecting'; shellIndex: number } | { kind: 'running'; shellIndex: number } | { kind: 'exited'; shellIndex: number } | { kind: 'error'; message: string };

/** A request to show one shell; a new `seq` asks again for the same index. */
export interface RemoteShellFocus {
  readonly shellIndex: number;
  readonly seq: number;
}

/** The project's live shell count and the shell on screen, null while none is attached or the peer is offline. */
export interface RemoteShellsState {
  readonly count: number;
  readonly shownShellIndex: number | null;
}

interface Props {
  readonly project: RemoteProjectSelection;
  readonly available: boolean;
  readonly onRefreshAvailability: () => void;
  /** Selects this shell once it is listed on the peer, for example after a notice click. */
  readonly focusShell?: RemoteShellFocus | null;
  /** Reports shell count and shown shell whenever either changes; reuses the 4 s `fleet:status` poll. */
  readonly onShellsChange?: (state: RemoteShellsState) => void;
}

interface SplitDeps {
  readonly peerId: string;
  readonly peerName: string;
  readonly projectId: number;
  readonly available: boolean;
  readonly shells: readonly FleetShell[];
  readonly refreshShells: () => Promise<readonly FleetShell[] | null>;
}

/**
 * The remote split: a plain shell launched on the peer for the right pane, the pane ratio, and the
 * shells hidden from the tab strip while their stop is in flight. `listed` records that a status
 * poll has shown the shell, so a later poll without it means it was stopped elsewhere and the split
 * closes. `close` stops the shell; `release` hands it back as an ordinary tab and returns its index.
 */
function useRemoteSplit({ peerId, peerName, projectId, available, shells, refreshShells }: SplitDeps) {
  const [split, setSplit] = useState<{ readonly shellIndex: number; readonly listed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<readonly number[]>([]);
  const [ratio, setRatio] = useState(SPLIT_RATIO_DEFAULT);
  const [epoch, setEpoch] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!split) return;
    const listed = shells.some((shell) => shell.shellIndex === split.shellIndex);
    if (listed && !split.listed) setSplit({ shellIndex: split.shellIndex, listed: true });
    if (!listed && split.listed) setSplit(null);
  }, [shells, split]);

  async function open() {
    if (!available || pending.current) return;
    pending.current = true;
    try {
      const result = await api.invoke('fleet:launch', { peerId, projectId });
      if (!alive.current) {
        void api.invoke('fleet:stop', { peerId, projectId, shellIndex: result.shellIndex }).catch(() => undefined);
        return;
      }
      setError(null);
      setSplit({ shellIndex: result.shellIndex, listed: false });
      void refreshShells().catch(() => undefined);
    } catch {
      if (alive.current) toast('Could not open the split shell', { kind: 'error', detail: `Check the connection to ${peerName} and retry.` });
    } finally {
      pending.current = false;
    }
  }

  function close() {
    if (!split) return;
    const index = split.shellIndex;
    setSplit(null);
    setHidden((current) => [...current, index]);
    void api.invoke('fleet:stop', { peerId, projectId, shellIndex: index })
      .then(() => refreshShells())
      .catch(() => {
        if (alive.current) toast('Could not stop the split shell', { kind: 'error', detail: 'It stays open as a tab; close it there to retry.' });
      })
      .finally(() => {
        if (alive.current) setHidden((current) => current.filter((item) => item !== index));
      });
  }

  function release(): number | null {
    setSplit(null);
    return split?.shellIndex ?? null;
  }

  function onStatus(status: RemotePaneStatus) {
    if (status.kind === 'exited') {
      setSplit(null);
      void refreshShells().catch(() => undefined);
    } else setError(status.kind === 'error' ? status.message : null);
  }

  return {
    shellIndex: split?.shellIndex ?? null, error, hidden, ratio, epoch,
    setRatio, open, close, release, onStatus, reconnect: () => setEpoch((value) => value + 1),
  };
}

/** Left share of the row's content box at a pointer x, as the local split computes it. */
function ratioAt(row: HTMLElement, clientX: number): number {
  const rect = row.getBoundingClientRect();
  const css = getComputedStyle(row);
  const padLeft = parseFloat(css.paddingLeft) || 0;
  const padRight = parseFloat(css.paddingRight) || 0;
  return clampRatio((clientX - rect.left - padLeft) / (rect.width - padLeft - padRight));
}

/** Window-level pointer tracking for a gutter drag; returns the dragging flag and its starter. */
function useDividerDrag(rowRef: RefObject<HTMLDivElement | null>, onRatioChange: (ratio: number) => void) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => { if (rowRef.current) onRatioChange(ratioAt(rowRef.current, event.clientX)); };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onRatioChange, rowRef]);
  return { dragging, startDrag: () => setDragging(true) };
}

/** Attaches only the shown remote PTYs (the left tab, plus the split's right shell); other shells stay alive on the peer. */
export function RemoteTerminal({ project, available, onRefreshAvailability, focusShell = null, onShellsChange }: Props) {
  const { peerId, peerName, projectId, projectName } = project;
  const [session, setSession] = useState<Session>({ kind: 'starting' });
  const [shellIndex, setShellIndex] = useState<number | null>(null);
  const [shells, setShells] = useState<readonly FleetShell[]>([]);
  const [defaultCliName, setDefaultCliName] = useState<string | null>(null);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const [stopping, setStopping] = useState(false);
  const paneControl = useRef<RemoteTerminalPaneControl | null>(null);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const mounted = useRef(true);
  const focusRef = useRef(focusShell);
  focusRef.current = focusShell;
  const handledFocus = useRef<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const refreshShells = useCallback(async () => {
    const request = ++statusRequest.current;
    const status = await api.invoke('fleet:status', { peerId });
    if (!mounted.current || statusRequest.current !== request) return null;
    const projectShells = status.shells.filter((shell) => shell.projectId === projectId);
    setShells(projectShells);
    return projectShells;
  }, [peerId, projectId]);

  const split = useRemoteSplit({ peerId, peerName, projectId, available, shells, refreshShells });
  const splitIndexRef = useRef(split.shellIndex);
  splitIndexRef.current = split.shellIndex;
  const releaseSplitRef = useRef(split.release);
  releaseSplitRef.current = split.release;
  const { dragging, startDrag } = useDividerDrag(rowRef, split.setRatio);

  const launch = useCallback(async (kind: 'claude' | 'plain' | 'cli', request?: { profileName?: string; argv?: string[]; save?: boolean }) => {
    if (!available) return;
    const attempt = ++generation.current;
    setStopping(false);
    setSession({ kind: 'starting' });
    try {
      const result = kind === 'claude'
        ? await api.invoke('fleet:launch-claude', { peerId, projectId })
        : kind === 'plain'
          ? await api.invoke('fleet:launch', { peerId, projectId })
          : await api.invoke('fleet:launch-cli', { peerId, projectId, ...request });
      if (mounted.current && generation.current === attempt) {
        setSession({ kind: 'connecting', shellIndex: result.shellIndex });
        setAttachmentEpoch((epoch) => epoch + 1);
        setShellIndex(result.shellIndex);
        void refreshShells().catch(() => undefined);
      }
    } catch (error) {
      if (mounted.current && generation.current === attempt) {
        const reason = error instanceof Error
          ? REMOTE_LAUNCH_ERRORS.find((known) => error.message.endsWith(known))
          : undefined;
        setSession({ kind: 'error', message: reason ??
          `Could not open ${kind === 'claude' ? 'Claude' : kind === 'plain' ? 'a plain shell' : 'the selected CLI'} on ${peerName}. Check the connection and remote launch settings, then retry.` });
      }
    }
  }, [available, peerId, peerName, projectId, refreshShells]);

  useEffect(() => {
    const currentGeneration = generation;
    const currentStatusRequest = statusRequest;
    let active = true;
    mounted.current = true;
    const attempt = ++generation.current;
    if (available) {
      void refreshShells().then((existing) => {
        if (!existing || !mounted.current || generation.current !== attempt) return;
        if (existing.length > 0) {
          const requested = focusRef.current;
          const wanted = requested && existing.some((shell) => shell.shellIndex === requested.shellIndex) ? requested : null;
          if (wanted) handledFocus.current = wanted.seq;
          const candidates = existing.filter((shell) => shell.shellIndex !== splitIndexRef.current);
          const index = wanted?.shellIndex ?? candidates.find((shell) => shell.shellIndex === 0)?.shellIndex ?? candidates[0]?.shellIndex ?? existing[0]!.shellIndex;
          if (index === splitIndexRef.current) releaseSplitRef.current();
          setShellIndex(index);
          setSession({ kind: 'connecting', shellIndex: index });
        } else void launch('claude');
      }).catch(() => {
        if (mounted.current && generation.current === attempt)
          setSession({ kind: 'error', message: `Could not load shells on ${peerName}. Check the connection and retry.` });
      });
      void api.invoke('fleet:profiles', { peerId, projectId }).then(({ defaultCliName }) => {
        if (active) setDefaultCliName(defaultCliName);
      }).catch(() => undefined);
    } else setShellIndex(null);
    return () => { active = false; currentStatusRequest.current++; mounted.current = false; currentGeneration.current++; };
  }, [available, launch, peerId, peerName, projectId, refreshShells]);

  useEffect(() => {
    if (!available) return;
    const timer = setInterval(() => { void refreshShells().catch(() => undefined); }, 4000);
    return () => clearInterval(timer);
  }, [available, refreshShells]);

  useEffect(() => {
    if (!focusShell || handledFocus.current === focusShell.seq || !shells.some((shell) => shell.shellIndex === focusShell.shellIndex)) return;
    handledFocus.current = focusShell.seq;
    if (focusShell.shellIndex === shellIndex || focusShell.shellIndex === split.shellIndex) return;
    setSession({ kind: 'connecting', shellIndex: focusShell.shellIndex });
    setShellIndex(focusShell.shellIndex);
  }, [focusShell, shells, shellIndex, split.shellIndex]);

  const shownShellIndex = available ? shellIndex : null;
  useEffect(() => {
    onShellsChange?.({ count: shells.length, shownShellIndex });
  }, [onShellsChange, shells.length, shownShellIndex]);

  async function stop(index = shellIndex) {
    if (index === null || !available || stopping) return;
    const attempt = generation.current;
    setStopping(true);
    try {
      await api.invoke('fleet:stop', { peerId, projectId, shellIndex: index });
      if (mounted.current && generation.current === attempt) {
        const remaining = shells.filter((shell) => shell.shellIndex !== index);
        setShells(remaining);
        if (shellIndex === index) {
          const others = remaining.filter((shell) => shell.shellIndex !== split.shellIndex);
          const nextIndex = (others.find((shell) => shell.shellIndex === 0) ?? others[0])?.shellIndex ?? split.release();
          setShellIndex(nextIndex);
          setSession(nextIndex !== null ? { kind: 'connecting', shellIndex: nextIndex } : { kind: 'exited', shellIndex: index });
        }
      }
    } catch {
      if (mounted.current && generation.current === attempt) setSession({ kind: 'error', message: 'Could not stop remote shell. Check the connection and retry.' });
    } finally {
      if (mounted.current && generation.current === attempt) setStopping(false);
    }
  }

  async function paste() {
    const isRunning = () => paneControl.current?.isRunning() ?? false;
    if (!isRunning()) return;
    try {
      const text = await navigator.clipboard.readText();
      paneControl.current?.paste(text);
    } catch {
      if (isRunning()) setSession({ kind: 'error', message: 'Could not read clipboard. Allow clipboard access and retry.' });
    }
  }

  function onLeftStatus(status: RemotePaneStatus, index: number) {
    setSession(status.kind === 'error' ? status : { kind: status.kind, shellIndex: index });
  }

  function select(index: number) {
    if (index === shellIndex) return;
    setSession({ kind: 'connecting', shellIndex: index });
    setShellIndex(index);
  }

  function moveSplitToTab() {
    const index = split.release();
    if (index !== null) select(index);
  }

  function launchCustom(name: string, cmdLine: string, save: boolean) {
    const argv: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(cmdLine)) !== null) argv.push(match[1] ?? match[2] ?? '');
    if (argv.length === 0) return;
    void launch('cli', { profileName: name || undefined, argv, save });
  }

  const remoteMenu = useMemo<RemoteShellMenu>(() => ({
    profiles: async () => (await api.invoke('fleet:profiles', { peerId, projectId })).profiles,
    remove: async (name) => { await api.invoke('fleet:remove-cli-profile', { peerId, projectId, name }); },
    setDefault: async (name) => {
      const result = await api.invoke('fleet:set-default-cli', { peerId, projectId, name });
      setDefaultCliName(result.defaultCliName);
    },
  }), [peerId, projectId]);

  const right = split.shellIndex;
  const location = `${projectName} · ${peerName}`;
  const dot = (index: number) => <StatusDot state={shells.find((shell) => shell.shellIndex === index)?.state ?? 'idle'} />;

  return (
    <section aria-label={`Remote project ${projectName} on ${peerName}`} data-testid="remote-workspace" className="flex h-full min-h-0 min-w-0 flex-col text-[--text]">
      <header className="flex flex-wrap items-center gap-1 px-2 pt-1.5 pb-1 text-xs shrink-0">
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 pr-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[--text] pl-2 pr-1 py-0.5 rounded-md bg-[--surface-active] text-[11px] max-w-[280px]" title={`${projectName} on ${peerName}`}>
            <StatusDot state={shells.find((shell) => shell.shellIndex === shellIndex)?.state ?? 'idle'} />
            <span className="truncate font-medium">{projectName} · {peerName}</span>
            <button type="button" onClick={() => void stop()} disabled={!available || shellIndex === null || stopping}
              className="ml-1 text-[--text-muted] hover:text-[--danger] hover:bg-[--panel]/60 w-4 h-4 flex items-center justify-center rounded disabled:opacity-40"
              title="Stop remote shell" aria-label="Stop remote shell">
              <XIcon />
            </button>
          </span>
          {!available && <button type="button" className={BUTTON} onClick={onRefreshAvailability}>Refresh connection</button>}
          <button type="button" className={BUTTON} disabled={!available || session.kind === 'starting'} onClick={() => {
            if (shellIndex === null) void launch('claude');
            else { setSession({ kind: 'connecting', shellIndex }); setAttachmentEpoch((epoch) => epoch + 1); split.reconnect(); }
          }}>Reconnect terminal</button>
          <button type="button" className={BUTTON} disabled={!available || session.kind !== 'running'} onClick={() => void paste()}>Paste</button>
        </div>
      </header>
      {available && (
        <ShellTabsBar
          projectId={projectId}
          shells={stripShells(shells, split.shellIndex, split.hidden)}
          active={shellIndex ?? -1}
          onSelect={select}
          onClose={(index) => void stop(index)}
          defaultCliName={defaultCliName}
          remoteMenu={remoteMenu}
          renderDot={(item: ShellTabsBarItem, active: boolean) =>
            <StatusDot state={item.state ?? 'idle'} agent={item.agent} inactiveWhenIdle={!active} />}
          onLaunchProfile={(name) => void launch('cli', { profileName: name })}
          onLaunchPlainTab={() => void launch('plain')}
          onLaunchCustom={launchCustom}
          splitOn={split.shellIndex !== null}
          onToggleSplit={() => (split.shellIndex !== null ? split.close() : void split.open())}
        />
      )}
      {!available && <p role="alert" className="p-4 text-base text-[--danger]">{peerName} is offline or unlinked. Reconnect or relink it to resume the terminal.</p>}
      {available && session.kind === 'starting' && <p role="status" className="p-4 text-base">Opening terminal on {peerName}…</p>}
      {available && session.kind === 'connecting' && <p role="status" className="p-4 text-base">Attaching terminal on {peerName}…</p>}
      {available && session.kind === 'error' && <p role="alert" className="p-4 text-base text-[--danger]">{session.message}</p>}
      {available && session.kind === 'exited' && <p role="status" className="p-4 text-base">Remote terminal ended. Choose a CLI or reconnect to start a session.</p>}
      {available && shellIndex !== null && (
        <div ref={rowRef} className={`flex min-h-0 min-w-0 flex-1 ${right !== null ? 'p-2' : ''}`}>
          <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${right !== null ? PANE_CARD : ''}`}>
            {right !== null && <SplitPaneHeader label={shellChipLabel(shells, shellIndex)} path={location} focused={false} dot={dot(shellIndex)} />}
            <RemoteTerminalPane key="left" peerId={peerId} projectId={projectId} shellIndex={shellIndex} epoch={attachmentEpoch}
              label={`Terminal for ${projectName} on ${peerName}`} onStatus={onLeftStatus} control={paneControl} />
          </div>
          {right !== null && (
            <>
              <SplitGutter ratio={split.ratio} dragging={dragging} onDragStart={startDrag} onRatioChange={split.setRatio} />
              <section data-testid={SPLIT_TESTIDS.right} aria-label={`Split terminal ${shellChipLabel(shells, right)}`}
                className={`flex min-h-0 min-w-0 shrink-0 grow-0 flex-col ${PANE_CARD}`} style={{ flexBasis: `${(1 - split.ratio) * 100}%` }}>
                <SplitPaneHeader label={shellChipLabel(shells, right)} path={location} focused={false} dot={dot(right)}
                  actions={{ onToTab: moveSplitToTab, onClose: split.close }} />
                {split.error !== null && <p role="alert" className="px-4 py-2 text-base text-[--danger]">{split.error}</p>}
                <RemoteTerminalPane key={`right:${right}`} peerId={peerId} projectId={projectId} shellIndex={right} epoch={split.epoch}
                  label={`Split terminal for ${projectName} on ${peerName}`} onStatus={split.onStatus} />
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}
