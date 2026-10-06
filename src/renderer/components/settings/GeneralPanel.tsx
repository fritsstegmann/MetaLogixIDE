import { useCallback, useEffect, useState } from 'react';
import type { SettingsMap } from '@shared/types';
import {
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  type FontFamilyPreference,
} from '@shared/font-settings';
import { api } from '@renderer/api';
import { useTheme, type ThemeMode } from '@renderer/hooks/useTheme';
import {
  FontControl,
  type FontDiscoveryState,
} from '@renderer/components/FontControl';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import { useFontSettings } from '@renderer/fonts/font-settings-context';
import { Field, Header } from '@renderer/components/settings/primitives';

/** Palette picker cards; swatches are each palette's own dark colours so every card previews itself. */
const PALETTE_CHOICES = [
  { id: 'default', label: 'Default', swatches: ['#1c2028', '#3b82f6', '#22c55e', '#fbbf24'] },
  { id: 'catppuccin', label: 'Catppuccin', swatches: ['#1e1e2e', '#89b4fa', '#a6e3a1', '#f5c2e7'] },
  { id: 'rose-pine', label: 'Rosé Pine', swatches: ['#191724', '#c4a7e7', '#9ccfd8', '#f6c177'] },
] as const;

/** General settings board: appearance, fonts, workspace limits and notifications. */
export function GeneralPanel({
  fontDiscovery,
  onLoadInstalledFonts,
}: {
  readonly fontDiscovery: FontDiscoveryState;
  readonly onLoadInstalledFonts: () => Promise<void>;
}) {
  const { mode, palette, effective, setMode, setPalette } = useTheme();
  const [cap, setCap] = useState<number | null>(null);
  const [scanDepth, setScanDepth] = useState<number | null>(null);
  const [maxWatched, setMaxWatched] = useState<number | null>(null);
  const [opacity, setOpacity] = useState<number>(100);
  const [notifyNeedsInput, setNotifyNeedsInput] = useState<boolean>(true);
  const [notifyFinished, setNotifyFinished] = useState<boolean>(true);

  const load = useCallback(async () => {
    const [c, d, w, o, ni, nf] = await Promise.all([
      api.invoke('settings:get', { key: 'keep_alive_cap' }),
      api.invoke('settings:get', { key: 'scan_depth' }),
      api.invoke('settings:get', { key: 'max_watched_paths' }),
      api.invoke('settings:get', { key: 'window_opacity' }),
      api.invoke('settings:get', { key: 'notify_claude_needs_input' }),
      api.invoke('settings:get', { key: 'notify_claude_finished' }),
    ]);
    setCap(c.value as number);
    setScanDepth(d.value as number);
    setMaxWatched(w.value as number);
    setOpacity((o.value as number) ?? 100);
    setNotifyNeedsInput((ni.value as boolean) ?? true);
    setNotifyFinished((nf.value as boolean) ?? true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]) {
    await api.invoke('settings:set', { key, value });
  }

  async function applyOpacity(v: number) {
    const clamped = Math.max(30, Math.min(100, Math.round(v)));
    setOpacity(clamped);
    await api.invoke('app:set-window-opacity', { percent: clamped });
  }

  return (
    <div className="space-y-6">
      <Header title="General" subtitle="Appearance and workspace defaults" />

      <Field label="Theme" hint="Choose the IDE palette. Catppuccin uses Mocha/Latte; Rosé Pine uses Rosé Pine/Dawn.">
        <div className="flex flex-wrap gap-2">
          {PALETTE_CHOICES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              aria-pressed={palette === theme.id}
              onClick={() => setPalette(theme.id)}
              className={`pressable flex w-36 flex-col gap-2 rounded-xl p-2.5 text-left text-sm transition-colors ${
                palette === theme.id
                  ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium ring-1 ring-[color:var(--accent)]'
                  : 'bg-[--surface-field] hover:bg-[--surface-active]'
              }`}
            >
              <span aria-hidden className="flex h-6 overflow-hidden rounded-md">
                {theme.swatches.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}
              </span>
              {theme.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Appearance" hint="Switch how the app renders. System follows your OS.">
        <div className="inline-flex gap-1 rounded-xl bg-[--surface-field] p-1">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((t) => (
            <button
              key={t}
              aria-pressed={mode === t}
              onClick={() => setMode(t)}
              className={`min-h-9 px-3.5 rounded-lg text-sm transition-colors ${
                mode === t
                  ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium'
                  : 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'system' && <span className="ml-1 text-xs opacity-70">({effective})</span>}
            </button>
          ))}
        </div>
      </Field>

      <FontSettingsControls
        discovery={fontDiscovery}
        onLoadInstalledFonts={onLoadInstalledFonts}
      />

      <Field label="Keep-alive cap" hint="How many project shells can stay running simultaneously. LRU evicts the oldest.">
        <NumberInput value={cap} min={1} max={20} onChange={(v) => { setCap(v); void save('keep_alive_cap', v); }} />
      </Field>

      <Field label="Root scan depth" hint="How many folder levels below a root count as projects. Raise for monorepos.">
        <NumberInput value={scanDepth} min={1} max={4} onChange={(v) => { setScanDepth(v); void save('scan_depth', v); }} />
      </Field>

      <Field label="Max watched paths" hint="Filesystem watcher cap across all roots. Prevents runaway CPU on huge trees.">
        <NumberInput value={maxWatched} min={50} max={5000} step={50} onChange={(v) => { setMaxWatched(v); void save('max_watched_paths', v); }} />
      </Field>

      <Field label="Window opacity" hint="How opaque every MetaLogix IDE window is. Drop below 100 % to see your desktop through the app.">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={30}
            max={100}
            step={1}
            value={opacity}
            onChange={(e) => void applyOpacity(Number(e.target.value))}
            className="flex-1 accent-[--accent]"
            data-testid="window-opacity-slider"
          />
          <span className="w-14 text-right text-sm text-[--text] font-mono">{opacity}%</span>
        </div>
      </Field>

      <Field label="Notifications" hint="OS notifications for Claude Code sessions running in app shells.">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-[--text]">
            <input
              type="checkbox"
              checked={notifyNeedsInput}
              onChange={(e) => { setNotifyNeedsInput(e.target.checked); void save('notify_claude_needs_input', e.target.checked); }}
              className="accent-[--accent]"
              data-testid="notify-needs-input-toggle"
            />
            Notify when Claude needs input
          </label>
          <label className="flex items-center gap-2 text-sm text-[--text]">
            <input
              type="checkbox"
              checked={notifyFinished}
              onChange={(e) => { setNotifyFinished(e.target.checked); void save('notify_claude_finished', e.target.checked); }}
              className="accent-[--accent]"
              data-testid="notify-finished-toggle"
            />
            Notify when Claude finishes
          </label>
        </div>
      </Field>
    </div>
  );
}

function FontSettingsControls({
  discovery,
  onLoadInstalledFonts,
}: {
  readonly discovery: FontDiscoveryState;
  readonly onLoadInstalledFonts: () => Promise<void>;
}) {
  const { uiFontFamily, terminalFontFamily } = useFontSettings();

  async function saveFont(
    key: 'ui_font_family' | 'terminal_font_family',
    value: FontFamilyPreference,
  ): Promise<void> {
    await api.invoke('settings:set-font', { key, value });
  }

  return (
    <section className="space-y-3" aria-labelledby="font-settings-heading">
      <div className="space-y-1">
        <h3 id="font-settings-heading" className="text-sm font-medium">{FONT_COPY.sectionLabel}</h3>
        <p className="text-xs text-[--text-muted]">Pick an installed font or type an exact family name.</p>
      </div>
      <FontControl
        settingKey="ui_font_family"
        label={FONT_COPY.uiLabel}
        value={uiFontFamily}
        fallback={UI_FONT_FALLBACK}
        discovery={discovery}
        onSave={(value) => saveFont('ui_font_family', value)}
        onLoadInstalledFonts={onLoadInstalledFonts}
      />
      <FontControl
        settingKey="terminal_font_family"
        label={FONT_COPY.terminalLabel}
        value={terminalFontFamily}
        fallback={TERMINAL_FONT_FALLBACK}
        discovery={discovery}
        onSave={(value) => saveFont('terminal_font_family', value)}
        onLoadInstalledFonts={onLoadInstalledFonts}
      />
    </section>
  );
}

function NumberInput({ value, min, max, step = 1, onChange }: { value: number | null; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
      }}
      className="w-32 bg-[--surface-field] text-[--text] rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[--accent]/60"
    />
  );
}
