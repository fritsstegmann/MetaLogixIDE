/** Fleet activity shows discovery and trust controls; remote projects live in Projects. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { FleetPeer, FleetState } from '@shared/fleet-contract';

const BUTTON = 'min-h-11 max-w-full rounded-lg border border-[--border] px-3 text-base text-[--text] hover:bg-[--surface-hover] focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 disabled:opacity-50';
const FIELD = 'min-h-11 w-full rounded-lg border border-[--border] bg-[--surface-field] px-3 text-base text-[--text] focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2';

interface Props {
  readonly onOpenSettings: () => void;
}

interface PeerRowProps {
  readonly peer: FleetPeer;
  readonly busy: boolean;
  readonly code: string;
  readonly onCode: (value: string) => void;
  readonly onAction: (kind: 'pair' | 'approve' | 'revoke') => void;
}

function PeerRow({ peer, busy, code, onCode, onAction }: PeerRowProps) {
  return (
    <li className="min-w-0 space-y-3 rounded-lg border border-[--border] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-words text-base font-semibold">{peer.name}</h3>
        <span className="text-base text-[--text-muted]">{{ discovered: 'Discovered', pending: 'Awaiting approval', linked: 'Linked', offline: 'Offline' }[peer.status]}</span>
      </div>
      {peer.status === 'discovered' && <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('pair')}>Request link</button>}
      {peer.status === 'pending' && (
        <div className="space-y-3">
          {peer.verificationCode ? (
            <>
              <p className="text-base text-[--text-muted]">Compare this code on both devices. Approve only if they match.</p>
              <p className="font-mono text-base select-text">{peer.verificationCode}</p>
              <label className="block space-y-1 text-base" htmlFor={`fleet-code-${peer.id}`}>
                <span>Matching code for {peer.name}</span>
                <input id={`fleet-code-${peer.id}`} type="text" autoComplete="off" spellCheck={false} value={code} onChange={(event) => onCode(event.target.value)} className={FIELD} />
              </label>
              <button type="button" className={BUTTON} disabled={busy || code.trim() !== peer.verificationCode} onClick={() => onAction('approve')}>Approve link</button>
            </>
          ) : <p className="text-base text-[--text-muted]">Waiting for a verification code. Cancel and retry if pairing does not finish.</p>}
          <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('revoke')}>Cancel request</button>
        </div>
      )}
      {(peer.status === 'linked' || peer.status === 'offline') && (
        <div className="space-y-3">
          {peer.status === 'linked' && <p className="text-base text-[--text-muted]">Projects on this machine appear in the Projects sidebar.</p>}
          {peer.status === 'offline' && <p className="text-base text-[--text-muted]">Check that Fleet is enabled on both devices and they share a LAN.</p>}
          <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('revoke')}>Revoke link</button>
        </div>
      )}
    </li>
  );
}

/** Shows available machines and pairing controls without opening projects or shells. */
export function FleetPanel({ onOpenSettings }: Props) {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [code, setCode] = useState<{ peerId: string; value: string } | null>(null);
  const stateRef = useRef<FleetState | null>(null);
  const applyState = useCallback((next: FleetState) => {
    stateRef.current = next;
    setState(next);
    setError('');
    setCode((previous) => previous && next.peers.some((peer) => peer.id === previous.peerId && peer.status === 'pending' && peer.verificationCode) ? previous : null);
  }, []);
  useEffect(() => {
    let active = true;
    const off = api.on('fleet:changed', (next) => { if (active) applyState(next); });
    void api.invoke('fleet:get-state', undefined).then((next) => {
      if (active && !stateRef.current) applyState(next);
    }).catch(() => {
      if (active && !stateRef.current) setError('Could not load Fleet. Check the app connection and retry.');
    });
    return () => { active = false; off(); };
  }, [applyState]);

  async function retry() {
    const previous = stateRef.current;
    setError('');
    try {
      const next = await api.invoke('fleet:get-state', undefined);
      if (stateRef.current === previous) applyState(next);
    } catch {
      if (stateRef.current === previous) setError('Could not load Fleet. Check the app connection and retry.');
    }
  }

  async function action(peer: FleetPeer, kind: 'pair' | 'approve' | 'revoke') {
    const current = stateRef.current;
    const latest = current?.peers.find((item) => item.id === peer.id);
    if (!current?.enabled || busyId || !latest || latest.status !== peer.status) return;
    if (kind === 'pair' && latest.status !== 'discovered') return;
    if (kind === 'approve' && (latest.status !== 'pending' || !latest.verificationCode || code?.peerId !== peer.id || code.value.trim() !== latest.verificationCode)) return;
    setBusyId(peer.id);
    setError('');
    try {
      if (kind === 'pair') await api.invoke('fleet:pair', { peerId: peer.id });
      else if (kind === 'approve' && code) await api.invoke('fleet:approve', { peerId: peer.id, verificationCode: code.value.trim() });
      else await api.invoke('fleet:revoke', { peerId: peer.id });
    } catch {
      setError(`Could not ${kind === 'pair' ? 'request link' : kind === 'approve' ? 'approve link' : 'revoke link'}. Check the connection and retry.`);
    } finally { setBusyId(null); }
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col text-[--text]" data-testid="fleet-panel" data-view="fleet" aria-label="Fleet">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[--border] px-4 py-3">
        <h2 className="text-lg font-semibold">Fleet</h2>
        <button type="button" className={BUTTON} onClick={onOpenSettings}>Open Fleet settings</button>
      </header>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {error && <p role="alert" className="mb-3 text-base text-[--danger]">{error}</p>}
        {!state && (error ? <button type="button" className={BUTTON} onClick={() => void retry()}>Retry</button> : <p role="status" className="text-base">Loading Fleet…</p>)}
        {state?.error && <p role="alert" className="mb-3 text-base text-[--danger]">{state.error}</p>}
        {state && !state.enabled && <p className="text-base text-[--text-muted]">Fleet is off. Turn it on in Settings to discover IDEs on your local network.</p>}
        {state?.enabled && (state.peers.length ? <ul aria-label="Fleet machines" className="grid min-w-0 gap-3 md:grid-cols-2">{state.peers.map((peer) => <PeerRow key={peer.id} peer={peer} busy={busyId !== null} code={code?.peerId === peer.id ? code.value : ''} onCode={(value) => setCode({ peerId: peer.id, value })} onAction={(kind) => void action(peer, kind)} />)}</ul> : <p role="status" className="text-base text-[--text-muted]">Looking for IDEs on this LAN. Check the network and multicast if none appear.</p>)}
      </div>
    </section>
  );
}
