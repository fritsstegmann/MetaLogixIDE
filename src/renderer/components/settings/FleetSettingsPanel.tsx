/** Fleet settings owns the opt-in discovery switch and reports listener or save failures without exposing network diagnostics. */
import { useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { FleetState } from '@shared/fleet-contract';
import { Header, SettingsSection, Switch } from './primitives';

/** Controls LAN discovery from Settings; pairing and remote-shell controls remain in the Fleet view. */
export function FleetSettingsPanel(): React.JSX.Element {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
      setError('');
    });
    void loadState();
    return () => {
      mounted.current = false;
      off();
    };
  }, []);

  async function changeEnabled(enabled: boolean): Promise<void> {
    if (busy || !state || state.enabled === enabled) return;
    const startingRevision = revision.current;
    setBusy(true);
    setError('');
    try {
      const next = await api.invoke('fleet:set-enabled', { enabled });
      if (mounted.current && revision.current === startingRevision) {
        latest.current = next;
        setState(next);
      }
    } catch {
      if (mounted.current && revision.current === startingRevision)
        setError('Could not change Fleet setting. Check the network connection and retry.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Header
        title="Fleet"
        subtitle="Connect IDEs on your local network. Discovery starts only when you turn Fleet on."
      />
      <SettingsSection title="Network discovery">
        {!state && !error && (
          <p role="status" className="text-base text-[--text-muted]">
            Loading Fleet settings…
          </p>
        )}
        {state && (
          <fieldset disabled={busy} aria-busy={busy} className="[&_label]:min-h-11">
            <legend className="sr-only">Fleet discovery</legend>
            <Switch
              label="Enable Fleet"
              ariaLabel="Enable Fleet discovery"
              testId="fleet-enabled"
              checked={state.enabled}
              onChange={(next) => {
                void changeEnabled(next);
              }}
            />
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
            className="min-h-11 rounded-lg border border-[--border] px-4 text-base focus-visible:ring-2 focus-visible:ring-[--accent]"
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
