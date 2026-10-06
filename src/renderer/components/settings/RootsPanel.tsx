import { useCallback, useEffect, useState } from 'react';
import type { Root } from '@shared/types';
import { api } from '@renderer/api';
import { Header } from '@renderer/components/settings/primitives';

/** Root directories settings panel. */
export function RootsPanel() {
  const [roots, setRoots] = useState<Root[]>([]);

  const refresh = useCallback(async () => {
    const { roots } = await api.invoke('roots:list', undefined as never);
    setRoots(roots);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function add() {
    const picked = await api.invoke('dialogs:pick-directory', undefined as never);
    if (!picked.path) return;
    await api.invoke('roots:add', { path: picked.path });
    await refresh();
  }
  async function remove(id: number) {
    if (!window.confirm('Remove this root? Projects underneath are un-registered.')) return;
    await api.invoke('roots:remove', { id });
    await refresh();
  }
  async function rescan(id: number) {
    await api.invoke('roots:rescan', { id });
  }

  return (
    <div className="space-y-4">
      <Header title="Root directories" subtitle="Folders scanned for projects. Add each parent folder where your projects live." />
      <button
        onClick={add}
        className="w-full text-sm font-medium pressable bg-[--accent-soft] hover:brightness-125 text-[--accent-soft-text] rounded-lg py-2"
      >
        + Add root
      </button>
      <ul className="space-y-2">
        {roots.length === 0 && <li className="text-sm text-[--text-muted]">No roots yet.</li>}
        {roots.map((r) => (
          <li key={r.id} className="flex items-center gap-2 rounded-lg px-3 py-2 bg-[--surface-field]">
            <span className="flex-1 text-sm truncate font-mono" title={r.path}>{r.path}</span>
            <button onClick={() => rescan(r.id)} className="text-xs text-[--text-muted] hover:text-[--text] px-2 py-1 rounded hover:bg-[--surface-hover]">Rescan</button>
            <button onClick={() => remove(r.id)} className="text-xs text-[--danger] hover:brightness-110 px-2 py-1 rounded hover:bg-[--surface-hover]">Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
