/** Fleet activity sheet controls discovery and trust; remote projects remain in Projects. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { FleetPeer, FleetState } from '@shared/fleet-contract';
import { Switch } from './settings/primitives';

const BUTTON = 'min-h-11 max-w-full rounded-lg border border-[--border] px-3 text-base text-[--text] hover:bg-[--surface-hover] focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 disabled:opacity-50';
const FIELD = 'min-h-11 w-full rounded-lg border border-[--border] bg-[--surface-field] px-3 text-base text-[--text] focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2';

/** Strips Electron's IPC wrapper so the main-side rejection reads as written. */
function rejectionMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

/** Port field with save action and the firewall rules that port needs; fully controlled by FleetPanel. */
function PortSettings({
  port,
  value,
  busy,
  onChange,
  onSave,
}: {
  readonly port: number;
  readonly value: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
}) {
  return (
    <section aria-label="Fleet port" className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={1024}
          max={65535}
          aria-label="Fleet port"
          className={`${FIELD} !w-32`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className={BUTTON}
          disabled={busy || value.trim() === '' || value === String(port)}
          onClick={onSave}
        >
          Save port
        </button>
      </div>
      <p className="text-base text-[--text-muted]">
        If a firewall blocks Fleet, allow it on every device: <code>sudo ufw allow 43871/udp</code>{' '}
        and <code>sudo ufw allow {port}/tcp</code>
      </p>
    </section>
  );
}

/** Two-step identity reset; only mounted when the stored identity is unreadable. */
function IdentityRecovery({
  armed,
  busy,
  onClick,
}: {
  readonly armed: boolean;
  readonly busy: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className={BUTTON} disabled={busy} onClick={onClick}>
      {armed ? 'Confirm reset — paired devices must pair again' : 'Reset identity'}
    </button>
  );
}

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

/** Controls discovery and peer linking in a compact side sheet without owning remote terminals. */
export function FleetPanel({ onOpenSettings }: Props) {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyEnabled, setBusyEnabled] = useState(false);
  const [code, setCode] = useState<{ peerId: string; value: string } | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [busyConfig, setBusyConfig] = useState(false);
  const stateRef = useRef<FleetState | null>(null);
  const applyState = useCallback((next: FleetState) => {
    stateRef.current = next;
    if (!next.recovery) setResetArmed(false);
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

  async function changeEnabled(enabled: boolean) {
    const previous = stateRef.current;
    if (!previous || previous.enabled === enabled || busyEnabled) return;
    setBusyEnabled(true);
    setError('');
    try {
      const next = await api.invoke('fleet:set-enabled', { enabled });
      if (stateRef.current === previous) applyState(next);
    } catch {
      if (stateRef.current !== previous) return;
      // A listener failure (e.g. the port is taken) is recorded on the state; show that instead of the generic message.
      const recovered = await api.invoke('fleet:get-state', undefined).catch(() => null);
      if (stateRef.current !== previous) return;
      if (recovered) applyState(recovered);
      if (!recovered?.error) setError('Could not change Fleet discovery. Check the network and retry.');
    } finally {
      setBusyEnabled(false);
    }
  }

  async function savePort(current: FleetState) {
    const port = Number(portDraft ?? current.port);
    setBusyConfig(true);
    setError('');
    try {
      applyState(await api.invoke('fleet:set-port', { port }));
      setPortDraft(null);
    } catch (failure) {
      setError(rejectionMessage(failure) || 'Could not change fleet port.');
    } finally {
      setBusyConfig(false);
    }
  }

  async function resetIdentity() {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    setBusyConfig(true);
    setError('');
    try {
      applyState(await api.invoke('fleet:reset-identity', undefined));
    } catch {
      setError('Could not reset fleet identity. Check the credential store and retry.');
    } finally {
      setBusyConfig(false);
    }
  }

  async function action(peer: FleetPeer, kind: 'pair' | 'approve' | 'revoke') {
    const current = stateRef.current;
    const latest = current?.peers.find((item) => item.id === peer.id);
    if (!current?.enabled || busyId || busyEnabled || !latest || latest.status !== peer.status) return;
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
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[--border] px-3 py-2">
        <h2 className="text-sm font-medium">Fleet</h2>
        <button type="button" aria-label="Open Fleet settings" className="min-h-11 rounded-md px-2 text-sm text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover] focus-visible:ring-2 focus-visible:ring-[--accent]" onClick={onOpenSettings}>Settings</button>
      </header>
      {state && (
        <fieldset disabled={busyEnabled} aria-busy={busyEnabled} className="shrink-0 border-b border-[--border] px-3 py-3">
          <legend className="sr-only">Fleet discovery</legend>
          <Switch label="Enable Fleet" ariaLabel="Enable Fleet discovery" testId="fleet-sheet-enabled"
            checked={state.enabled} onChange={(enabled) => void changeEnabled(enabled)} />
        </fieldset>
      )}
      <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
        {error && <p role="alert" className="mb-3 text-base text-[--danger]">{error}</p>}
        {!state && (error ? <button type="button" className={BUTTON} onClick={() => void retry()}>Retry</button> : <p role="status" className="text-base">Loading Fleet…</p>)}
        {state?.error && <p role="alert" className="mb-3 text-base text-[--danger]">{state.error}</p>}
        {state?.recovery === 'reset-identity' && (
          <div className="mb-3">
            <IdentityRecovery armed={resetArmed} busy={busyConfig} onClick={() => void resetIdentity()} />
          </div>
        )}
        {state && !state.enabled && <p className="text-base text-[--text-muted]">Fleet is off. Enable discovery above to find IDEs on your local network.</p>}
        {state?.enabled && (state.peers.length ? <ul aria-label="Fleet machines" className="flex min-w-0 flex-col gap-3">{state.peers.map((peer) => <PeerRow key={peer.id} peer={peer} busy={busyId !== null} code={code?.peerId === peer.id ? code.value : ''} onCode={(value) => setCode({ peerId: peer.id, value })} onAction={(kind) => void action(peer, kind)} />)}</ul> : <p role="status" className="text-base text-[--text-muted]">Looking for IDEs on this LAN. Check the network and multicast if none appear.</p>)}
        {state && (
          <PortSettings
            port={state.port}
            value={portDraft ?? String(state.port)}
            busy={busyConfig}
            onChange={setPortDraft}
            onSave={() => void savePort(state)}
          />
        )}
      </div>
    </section>
  );
}
