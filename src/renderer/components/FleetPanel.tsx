/** Opt-in LAN fleet panel keeps remote shell controls behind an approved, currently linked peer. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@renderer/api';
import { AGENT_STATE_LABEL, AGGREGATE_STATE_LABEL } from '@shared/agent-state';
import type { FleetPeer, FleetState, FleetStatus, FleetShell } from '@shared/fleet-contract';

const BUTTON =
  'min-h-11 rounded-lg border border-[--border] px-3 text-base text-[--text] hover:bg-[--surface-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-50';
const FIELD =
  'min-h-11 w-full min-w-0 rounded-lg border border-[--border] bg-[--surface-field] px-3 text-base text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

type RemoteStatus =
  | { readonly kind: 'loading'; readonly peerId: string }
  | { readonly kind: 'ready'; readonly peerId: string; readonly data: FleetStatus }
  | { readonly kind: 'error'; readonly peerId: string };
type RemoteSnapshot =
  | { readonly kind: 'loading'; readonly key: string }
  | {
      readonly kind: 'ready';
      readonly key: string;
      readonly output: string;
      readonly alive: boolean;
    }
  | { readonly kind: 'error'; readonly key: string };

interface PeerRowProps {
  readonly peer: FleetPeer;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly code: string;
  readonly onCode: (code: string) => void;
  readonly onPair: () => void;
  readonly onApprove: () => void;
  readonly onRevoke: () => void;
  readonly onSelect: () => void;
}

function PeerRow({
  peer,
  selected,
  busy,
  code,
  onCode,
  onPair,
  onApprove,
  onRevoke,
  onSelect,
}: PeerRowProps) {
  const pairing = peer.status === 'pending' && peer.verificationCode;
  return (
    <li className="min-w-0 space-y-2 rounded-lg border border-[--border] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 break-words text-base font-medium">{peer.name}</div>
        <span aria-live="polite" className="text-base text-[--text-muted]">
          {
            {
              discovered: 'Discovered',
              pending: 'Awaiting approval',
              linked: 'Linked',
              offline: 'Offline',
            }[peer.status]
          }
        </span>
      </div>
      {peer.status === 'discovered' && (
        <button type="button" className={BUTTON} disabled={busy} onClick={onPair}>
          Request link
        </button>
      )}
      {peer.status === 'pending' && (
        <div className="space-y-2">
          {pairing ? (
            <>
              <p className="text-base text-[--text-muted]">
                Compare this code on both devices. Enter it below only if they match.
              </p>
              <p className="font-mono text-base tracking-wide select-text">
                {peer.verificationCode}
              </p>
              <label className="block space-y-1 text-base" htmlFor={`fleet-code-${peer.id}`}>
                <span>Matching code from both devices</span>
                <input
                  id={`fleet-code-${peer.id}`}
                  aria-label="Matching code from both devices"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(event) => onCode(event.target.value)}
                  className={FIELD}
                />
              </label>
              <button
                type="button"
                className={BUTTON}
                disabled={busy || code.trim() !== peer.verificationCode}
                onClick={onApprove}
              >
                Approve link
              </button>
            </>
          ) : (
            <p className="text-base text-[--text-muted]">
              Waiting for a verification code. If pairing does not finish, cancel and try again.
            </p>
          )}
          <button type="button" className={BUTTON} disabled={busy} onClick={onRevoke}>
            Cancel request
          </button>
        </div>
      )}
      {peer.status === 'linked' && (
        <div className="flex flex-wrap gap-2">
          {!selected && (
            <button type="button" className={BUTTON} onClick={onSelect}>
              View {peer.name}
            </button>
          )}
          <button type="button" className={BUTTON} disabled={busy} onClick={onRevoke}>
            Revoke link
          </button>
        </div>
      )}
      {peer.status === 'offline' && (
        <div className="space-y-2">
          <p className="text-base text-[--text-muted]">
            This machine is offline. Check that fleet is enabled there and both devices are on the
            same LAN.
          </p>
          <button type="button" className={BUTTON} disabled={busy} onClick={onRevoke}>
            Revoke link
          </button>
        </div>
      )}
    </li>
  );
}

interface RemoteViewProps {
  readonly peer: FleetPeer;
  readonly status: RemoteStatus | null;
  readonly snapshot: RemoteSnapshot | null;
  readonly selectedShell: Pick<FleetShell, 'projectId' | 'shellIndex'> | null;
  readonly input: string;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onLaunch: (projectId: number) => void;
  readonly onSelectShell: (shell: FleetShell) => void;
  readonly onStop: (shell: FleetShell) => void;
  readonly onInput: (input: string) => void;
  readonly onSend: (event: FormEvent<HTMLFormElement>) => void;
}

function RemoteView({
  peer,
  status,
  snapshot,
  selectedShell,
  input,
  busy,
  onRefresh,
  onLaunch,
  onSelectShell,
  onStop,
  onInput,
  onSend,
}: RemoteViewProps) {
  const loaded = status?.kind === 'ready' && status.peerId === peer.id ? status.data : null;
  const currentShell =
    selectedShell &&
    loaded?.shells.some(
      (shell) =>
        shell.projectId === selectedShell.projectId &&
        shell.shellIndex === selectedShell.shellIndex,
    )
      ? selectedShell
      : null;
  const shellKey = currentShell
    ? `${peer.id}:${currentShell.projectId}:${currentShell.shellIndex}`
    : null;
  const currentSnapshot = snapshot && snapshot.key === shellKey ? snapshot : null;
  return (
    <section
      aria-label={`Remote machine: ${peer.name}`}
      className="min-w-0 space-y-3 border-t border-[--border] pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-words text-base font-semibold">Remote machine: {peer.name}</h3>
        <button type="button" className={BUTTON} disabled={busy} onClick={onRefresh}>
          Refresh remote status
        </button>
      </div>
      {(!status || status.kind === 'loading' || status.peerId !== peer.id) && (
        <p role="status" className="text-base text-[--text-muted]">
          Loading remote status…
        </p>
      )}
      {status?.kind === 'error' && status.peerId === peer.id && (
        <p role="alert" className="text-base text-[--danger]">
          Could not load remote status. Check the connection and the peer’s 256-project and
          256-shell Fleet limit, then refresh.
        </p>
      )}
      {loaded && (
        <>
          {loaded.projects.length === 0 && (
            <p className="text-base text-[--text-muted]">No projects on this machine.</p>
          )}
          <ul className="space-y-3">
            {loaded.projects.map((project) => (
              <li
                key={project.id}
                className="min-w-0 space-y-2 rounded-lg border border-[--border] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="min-w-0 break-words text-base font-medium">{project.name}</h4>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => onLaunch(project.id)}
                  >
                    Launch shell on {peer.name} in {project.name}
                  </button>
                </div>
                <ul className="space-y-2">
                  {loaded.shells
                    .filter((shell) => shell.projectId === project.id)
                    .map((shell) => (
                      <li
                        key={shell.shellIndex}
                        className="flex flex-wrap items-center gap-2 text-base"
                      >
                        <span>
                          Shell {shell.shellIndex + 1} —{' '}
                          {shell.agent
                            ? AGENT_STATE_LABEL[shell.agent][shell.state]
                            : AGGREGATE_STATE_LABEL[shell.state]}
                        </span>
                        <button
                          type="button"
                          className={BUTTON}
                          onClick={() => onSelectShell(shell)}
                        >
                          View shell {shell.shellIndex + 1}
                        </button>
                        <button
                          type="button"
                          className={BUTTON}
                          disabled={busy}
                          onClick={() => onStop(shell)}
                        >
                          Stop shell {shell.shellIndex + 1} on {peer.name}
                        </button>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
          {currentShell && shellKey && (
            <div className="min-w-0 space-y-2">
              <h4 className="text-base font-medium">
                Remote shell {currentShell.shellIndex + 1} on {peer.name}
              </h4>
              {currentSnapshot?.kind === 'error' && (
                <p role="alert" className="text-base text-[--danger]">
                  Could not read remote output. Check the connection, then refresh remote status.
                </p>
              )}
              <pre
                role="log"
                aria-label={`Output from ${peer.name} shell ${currentShell.shellIndex + 1}`}
                className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[--border] bg-[--surface-field] p-3 font-mono text-base text-[--text]"
              >
                {currentSnapshot?.kind === 'ready'
                  ? currentSnapshot.output
                  : currentSnapshot?.kind === 'error'
                    ? 'Output unavailable.'
                    : 'Loading shell output…'}
              </pre>
              {currentSnapshot?.kind === 'ready' && !currentSnapshot.alive && (
                <p role="status">
                  This remote shell has exited. Refresh remote status to choose a running shell.
                </p>
              )}
              <p className="text-base text-[--text-muted]">
                Input goes to {peer.name} and can run commands there.
              </p>
              <form onSubmit={onSend} className="space-y-2">
                <label htmlFor="fleet-shell-input" className="block text-base">
                  Input to {peer.name} shell {currentShell.shellIndex + 1}
                </label>
                <textarea
                  id="fleet-shell-input"
                  aria-label={`Input to ${peer.name} shell ${currentShell.shellIndex + 1}`}
                  rows={2}
                  className={`${FIELD} py-2`}
                  value={input}
                  onChange={(event) => onInput(event.target.value)}
                  disabled={busy || currentSnapshot?.kind !== 'ready' || !currentSnapshot.alive}
                />
                <button
                  type="submit"
                  className={BUTTON}
                  disabled={
                    busy || !input || currentSnapshot?.kind !== 'ready' || !currentSnapshot.alive
                  }
                >
                  Send to {peer.name}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function invalidateRequest(request: { current: number }): void {
  request.current++;
}

/** Displays discovered devices and requires code comparison before enabling remote controls for each linked machine. */
export function FleetPanel() {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [code, setCode] = useState<{ readonly peerId: string; readonly value: string } | null>(
    null,
  );
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [selectedShell, setSelectedShell] = useState<Pick<
    FleetShell,
    'projectId' | 'shellIndex'
  > | null>(null);
  const [input, setInput] = useState('');
  const request = useRef(0);
  const pendingStatus = useRef<{ readonly peerId: string; readonly sequence: number } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const currentState = useRef<FleetState | null>(null);
  const selectedPeer = state?.enabled
    ? (state.peers.find((peer) => peer.id === selectedId && peer.status === 'linked') ??
      state.peers.find((peer) => peer.status === 'linked'))
    : undefined;

  const applyState = useCallback((next: FleetState) => {
    const previousSelected =
      currentState.current?.peers.find(
        (peer) => peer.id === selectedIdRef.current && peer.status === 'linked',
      ) ?? currentState.current?.peers.find((peer) => peer.status === 'linked');
    const nextSelected = next.enabled
      ? (next.peers.find((peer) => peer.id === selectedIdRef.current && peer.status === 'linked') ??
        next.peers.find((peer) => peer.status === 'linked'))
      : undefined;
    if (previousSelected?.id !== nextSelected?.id) {
      pendingStatus.current = null;
      request.current++;
      setStatus(null);
      setSnapshot(null);
      setSelectedShell(null);
      setInput('');
    }
    currentState.current = next;
    setState(next);
    setCode((previous) =>
      previous &&
      next.peers.some(
        (peer) => peer.id === previous.peerId && peer.status === 'pending' && peer.verificationCode,
      )
        ? previous
        : null,
    );
  }, []);

  useEffect(() => {
    let active = true;
    const off = api.on('fleet:changed', (next) => {
      if (active) applyState(next);
    });
    void api
      .invoke('fleet:get-state', undefined)
      .then((next) => {
        if (active && !currentState.current) applyState(next);
      })
      .catch(() => {
        if (active) setError('Could not load fleet. Check the app connection and retry.');
      });
    return () => {
      active = false;
      invalidateRequest(request);
      pendingStatus.current = null;
      off();
    };
  }, [applyState]);

  const refreshStatus = useCallback(async (peerId: string, polling = false) => {
    const current = currentState.current;
    const selected = current?.enabled
      ? (current.peers.find(
          (peer) => peer.id === selectedIdRef.current && peer.status === 'linked',
        ) ?? current.peers.find((peer) => peer.status === 'linked'))
      : undefined;
    if (selected?.id !== peerId || (polling && pendingStatus.current?.peerId === peerId)) return;
    const sequence = ++request.current;
    pendingStatus.current = { peerId, sequence };
    if (!polling) {
      setStatus({ kind: 'loading', peerId });
      setSnapshot(null);
    }
    try {
      const data = await api.invoke('fleet:status', { peerId });
      if (
        sequence === request.current &&
        currentState.current?.enabled &&
        currentState.current.peers.find((peer) => peer.id === peerId)?.status === 'linked'
      )
        setStatus({ kind: 'ready', peerId, data });
    } catch {
      if (sequence === request.current) setStatus({ kind: 'error', peerId });
    } finally {
      if (pendingStatus.current?.sequence === sequence) pendingStatus.current = null;
    }
  }, []);

  const peerId = selectedPeer?.id;
  useEffect(() => {
    if (!peerId) return;
    void refreshStatus(peerId);
    const timer = window.setInterval(() => {
      void refreshStatus(peerId, true);
    }, 3000);
    return () => {
      invalidateRequest(request);
      pendingStatus.current = null;
      window.clearInterval(timer);
    };
  }, [peerId, refreshStatus]);

  const projectId = selectedShell?.projectId;
  const shellIndex = selectedShell?.shellIndex;
  const shellKey =
    peerId && projectId !== undefined && shellIndex !== undefined
      ? `${peerId}:${projectId}:${shellIndex}`
      : null;
  const shellAvailable =
    status?.kind === 'ready' &&
    status.peerId === peerId &&
    status.data.shells.some(
      (shell) => shell.projectId === projectId && shell.shellIndex === shellIndex,
    );
  useEffect(() => {
    if (
      !peerId ||
      projectId === undefined ||
      shellIndex === undefined ||
      !shellAvailable ||
      !shellKey
    )
      return;
    const target = { peerId, projectId, shellIndex, key: shellKey };
    let active = true;
    let pending = false;
    async function readSnapshot() {
      if (pending || !active) return;
      if (
        !currentState.current?.enabled ||
        currentState.current.peers.find((peer) => peer.id === target.peerId)?.status !== 'linked'
      )
        return;
      pending = true;
      try {
        const next = await api.invoke('fleet:snapshot', {
          peerId: target.peerId,
          projectId: target.projectId,
          shellIndex: target.shellIndex,
        });
        if (
          active &&
          currentState.current?.enabled &&
          currentState.current.peers.find((peer) => peer.id === target.peerId)?.status === 'linked'
        )
          setSnapshot({ kind: 'ready', key: target.key, ...next });
      } catch {
        if (
          active &&
          currentState.current?.enabled &&
          currentState.current.peers.find((peer) => peer.id === target.peerId)?.status === 'linked'
        )
          setSnapshot({ kind: 'error', key: target.key });
      } finally {
        pending = false;
      }
    }
    setSnapshot({ kind: 'loading', key: shellKey });
    void readSnapshot();
    const timer = window.setInterval(() => {
      void readSnapshot();
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [peerId, projectId, shellIndex, shellAvailable, shellKey]);

  async function action(message: string, call: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await call();
    } catch {
      setError(`${message}. Check the connection or remote machine, then retry.`);
    } finally {
      setBusy(false);
    }
  }

  async function changeEnabled(enabled: boolean) {
    await action('Could not change fleet setting', async () => {
      applyState(await api.invoke('fleet:set-enabled', { enabled }));
    });
  }

  async function runPeer(peer: FleetPeer, kind: 'pair' | 'approve' | 'revoke') {
    if (!currentState.current?.enabled) return;
    const current = currentState.current?.peers.find((item) => item.id === peer.id);
    if (kind === 'pair' && current?.status !== 'discovered') return;
    if (
      kind === 'approve' &&
      (current?.status !== 'pending' ||
        !current.verificationCode ||
        code?.peerId !== peer.id ||
        code.value.trim() !== current.verificationCode)
    )
      return;
    await action(
      `Could not ${kind === 'pair' ? 'request link' : kind === 'approve' ? 'approve link' : 'revoke link'}`,
      async () => {
        if (kind === 'pair') await api.invoke('fleet:pair', { peerId: peer.id });
        else if (kind === 'approve' && code)
          await api.invoke('fleet:approve', {
            peerId: peer.id,
            verificationCode: code.value.trim(),
          });
        else await api.invoke('fleet:revoke', { peerId: peer.id });
      },
    );
  }

  function isLinked(peer: FleetPeer | undefined): peer is FleetPeer {
    return Boolean(
      peer &&
      currentState.current?.enabled &&
      currentState.current.peers.find((item) => item.id === peer.id)?.status === 'linked',
    );
  }

  async function launchShell(projectId: number) {
    const peer = selectedPeer;
    if (!isLinked(peer)) return;
    await action('Could not launch remote shell', async () => {
      const { shellIndex } = await api.invoke('fleet:launch', { peerId: peer.id, projectId });
      if (isLinked(peer)) {
        setSelectedShell({ projectId, shellIndex });
        setInput('');
        await refreshStatus(peer.id);
      }
    });
  }

  async function stopShell(shell: FleetShell) {
    const peer = selectedPeer;
    if (!isLinked(peer)) return;
    await action('Could not stop remote shell', async () => {
      await api.invoke('fleet:stop', {
        peerId: peer.id,
        projectId: shell.projectId,
        shellIndex: shell.shellIndex,
      });
      await refreshStatus(peer.id);
    });
  }

  async function sendInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const peer = selectedPeer;
    const shell = selectedShell;
    if (
      !isLinked(peer) ||
      !shell ||
      !input ||
      status?.kind !== 'ready' ||
      status.peerId !== peer.id ||
      !status.data.shells.some(
        (item) => item.projectId === shell.projectId && item.shellIndex === shell.shellIndex,
      ) ||
      snapshot?.kind !== 'ready' ||
      snapshot.key !== shellKey ||
      !snapshot.alive
    )
      return;
    await action('Could not send input', async () => {
      await api.invoke('fleet:write', {
        peerId: peer.id,
        projectId: shell.projectId,
        shellIndex: shell.shellIndex,
        data: input,
      });
      setInput('');
    });
  }

  async function retryLoad() {
    setError('');
    try {
      applyState(await api.invoke('fleet:get-state', undefined));
    } catch {
      setError('Could not load fleet. Check the app connection and retry.');
    }
  }

  return (
    <div className="h-full min-w-0 overflow-y-auto p-4 text-[--text]" data-testid="fleet-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Fleet</h2>
        {state && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void changeEnabled(!state.enabled)}
          >
            {state.enabled ? 'Disable fleet' : 'Enable fleet'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-base text-[--danger]">
          {error}
        </p>
      )}
      {!state && (
        <div className="mt-4 space-y-2">
          {!error && <p role="status">Loading fleet…</p>}
          {error && (
            <button type="button" className={BUTTON} onClick={() => void retryLoad()}>
              Retry
            </button>
          )}
        </div>
      )}
      {state?.error && (
        <p role="alert" className="mt-3 text-base text-[--danger]">
          {state.error}
        </p>
      )}
      {state && !state.enabled && (
        <p className="mt-4 text-base text-[--text-muted]">
          Fleet is off. Enable it to discover IDEs on your local network.
        </p>
      )}
      {state?.enabled && (
        <div className="mt-4 space-y-4">
          <p className="text-base text-[--text-muted]">
            Only linked devices can see projects or control shells. Compare pairing codes on both
            devices before approval.
          </p>
          {state.peers.length === 0 ? (
            <p role="status" className="text-base text-[--text-muted]">
              Looking for IDEs on this LAN. If none appear, check both devices are on the same
              network and multicast is allowed.
            </p>
          ) : (
            <ul className="space-y-3">
              {state.peers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  peer={peer}
                  selected={selectedPeer?.id === peer.id}
                  busy={busy}
                  code={code?.peerId === peer.id ? code.value : ''}
                  onCode={(value) => setCode({ peerId: peer.id, value })}
                  onPair={() => void runPeer(peer, 'pair')}
                  onApprove={() => void runPeer(peer, 'approve')}
                  onRevoke={() => void runPeer(peer, 'revoke')}
                  onSelect={() => {
                    invalidateRequest(request);
                    pendingStatus.current = null;
                    selectedIdRef.current = peer.id;
                    setSelectedId(peer.id);
                    setStatus(null);
                    setSnapshot(null);
                    setSelectedShell(null);
                    setInput('');
                  }}
                />
              ))}
            </ul>
          )}
          {selectedPeer && (
            <RemoteView
              peer={selectedPeer}
              status={status}
              snapshot={snapshot}
              selectedShell={selectedShell}
              input={input}
              busy={busy}
              onRefresh={() => void refreshStatus(selectedPeer.id)}
              onLaunch={(projectId) => void launchShell(projectId)}
              onSelectShell={(shell) => {
                setSelectedShell(shell);
                setSnapshot(null);
                setInput('');
              }}
              onStop={(shell) => void stopShell(shell)}
              onInput={setInput}
              onSend={(event) => {
                void sendInput(event);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
