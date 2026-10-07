import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { Field, Header } from '@renderer/components/settings/primitives';

/** Metaproject settings panel. */
export function MetaprojectPanel() {
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const { value } = await api.invoke('settings:get', { key: 'metaproject_base_url' });
        setUrl(typeof value === 'string' ? value : '');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function save() {
    let normalized = url.trim().replace(/\/+$/, '');
    if (normalized && !/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
    await api.invoke('settings:set', { key: 'metaproject_base_url', value: normalized });
    setUrl(normalized);
  }

  return (
    <div className="space-y-6">
      <Header
        title="Metaproject"
        subtitle="Optional. When set, projects with a .metaproject.yaml linking a project_id get a Board button that opens the board in your browser."
      />
      <Field label="Base URL" hint="Used to build /board/{project_id} links. Default: https://projects.metalogix.solutions.">
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') { void save(); (e.target as HTMLInputElement).blur(); } }}
            placeholder="https://projects.metalogix.solutions"
            className="flex-1 bg-[--surface-field] text-[--text] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
            data-testid="metaproject-base-url"
          />
        </div>
      </Field>
      <div className="text-xs text-[--text-muted] leading-relaxed">
        Add <code className="font-mono">project_id: PROJ-42</code> to a project&rsquo;s <code className="font-mono">.metaproject.yaml</code>
        &nbsp;and the sidebar will show a Board button linked to it. Live chat and ticket sync land in a later phase.
        {!loaded && <div className="mt-2 opacity-60">Loading…</div>}
      </div>
    </div>
  );
}
