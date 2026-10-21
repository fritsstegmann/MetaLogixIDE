/** Fleet settings owns the listener port and reports save failures; discovery is toggled from the Fleet sheet. */
import { useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { FLEET_DEFAULT_PORT, type FleetState } from '@shared/fleet-contract';
import { Header, SettingsSection } from './primitives';

const BUTTON =
  'min-h-11 rounded-lg border border-[--border] px-4 text-base text-[--text] hover:bg-[--surface-hover] focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-50';
const FIELD =
  'min-h-11 w-32 rounded-lg border border-[--border] bg-[--surface-field] px-3 text-base text-[--text] focus-visible:ring-2 focus-visible:ring-[--accent]';

/** Strips Electron's IPC wrapper so the main-side rejection reads as written. */
function rejectionMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

/** Sets the Fleet port from Settings; discovery, pairing and remote-shell controls remain in the Fleet sheet. */
export function FleetSettingsPanel(): React.JSX.Element {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef<FleetState | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);

  async function loadState(): Promise<void> {
    const startingRevision = revision.current;
    setError('');
    try {
      const next = await api.invoke('fleet:get-state', undefined);
      if (mounted.current && revision.current === startingRevision && !latest.current) {
        latest.current = next;
        setState(next);
      }
    } catch {
      if (mounted.current && !latest.current)
        setError('Could not load Fleet settings. Check the app connection and retry.');
    }
  }

  useEffect(() => {
    mounted.current = true;
    const off = api.on('fleet:changed', (next) => {
      if (!mounted.current) return;
      revision.current++;
      latest.current = next;
      setState(next);
    });
    void loadState();
    return () => {
      mounted.current = false;
      off();
    };
  }, []);

  async function savePort(port: number): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.invoke('fleet:set-port', { port });
      if (!mounted.current) return;
      revision.current++;
      latest.current = next;
      setState(next);
      setDraft(null);
    } catch (failure) {
      if (mounted.current) setError(rejectionMessage(failure) || 'Could not change Fleet port.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const value = draft ?? (state ? String(state.port) : '');

  return (
    <div className="space-y-6">
      <Header
        title="Fleet"
        subtitle="Connect IDEs on your local network. Turn Fleet on and pair devices from the Fleet sheet."
      />
      <SettingsSection
        title="Port"
        hint={`TCP port for Fleet connections. Default: ${FLEET_DEFAULT_PORT}.`}
      >
        {!state && !error && (
          <p role="status" className="text-base text-[--text-muted]">
            Loading Fleet settings…
          </p>
        )}
        {state && (
          <fieldset disabled={busy} aria-busy={busy} className="space-y-2">
            <legend className="sr-only">Fleet port</legend>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={1024}
                max={65535}
                aria-label="Fleet port"
                placeholder={String(FLEET_DEFAULT_PORT)}
                className={FIELD}
                value={value}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button
                type="button"
                className={BUTTON}
                disabled={busy || value.trim() === '' || value === String(state.port)}
                onClick={() => void savePort(Number(value))}
              >
                Save port
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy || state.port === FLEET_DEFAULT_PORT}
                onClick={() => void savePort(FLEET_DEFAULT_PORT)}
              >
                Use default
              </button>
            </div>
            <p className="text-base text-[--text-muted]">
              If a firewall blocks Fleet, allow it on every device:{' '}
              <code>sudo ufw allow 43871/udp</code> and <code>sudo ufw allow {state.port}/tcp</code>
            </p>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-base text-[--danger]">
            {error}
          </p>
        )}
        {state?.error && (
          <p role="alert" className="text-base text-[--danger]">
            {state.error}
          </p>
        )}
        {!state && error && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              void loadState();
            }}
          >
            Retry loading Fleet
          </button>
        )}
      </SettingsSection>
    </div>
  );
}
