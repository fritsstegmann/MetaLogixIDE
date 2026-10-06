import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaunchCmd, Root, SettingsMap } from '@shared/types';
import {
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  type FontFamilyPreference,
} from '@shared/font-settings';
import { parseArgv } from '@shared/parse-argv';
import { api } from '@renderer/api';
import { useTheme, type ThemeMode } from '@renderer/hooks/useTheme';
import { useClaudePermissionMode } from '@renderer/hooks/useClaudePermissionMode';
import { PermissionModeControl } from '@renderer/components/PermissionModeControl';
import {
  FontControl,
  type FontDiscoveryState,
} from '@renderer/components/FontControl';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import { useFontSettings } from '@renderer/fonts/font-settings-context';
import { discoverLocalFonts } from '@renderer/fonts/local-font-access';
import { PERMISSION_MODE_COPY, PERMISSION_MODE_TEST_IDS } from '@renderer/permission-mode-copy';
import type { ClaudePermissionMode } from '@shared/claude-permission-mode';
type Section = 'general' | 'roots' | 'launch' | 'metaproject';

/** Palette picker cards; swatches are each palette's own dark colours so every card previews itself. */
const PALETTE_CHOICES = [
  { id: 'default', label: 'Default', swatches: ['#1c2028', '#3b82f6', '#22c55e', '#fbbf24'] },
  { id: 'catppuccin', label: 'Catppuccin', swatches: ['#1e1e2e', '#89b4fa', '#a6e3a1', '#f5c2e7'] },
  { id: 'rose-pine', label: 'Rosé Pine', swatches: ['#191724', '#c4a7e7', '#9ccfd8', '#f6c177'] },
] as const;

/** Renders application settings and owns installed-font discovery for one open session. */
export function Settings({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const [section, setSection] = useState<Section>('general');
  const [fontDiscovery, setFontDiscovery] = useState<FontDiscoveryState>({ status: 'idle' });
  const fontDiscoveryAttempted = useRef(false);
  const fontDiscoveryGeneration = useRef(0);

  useEffect(() => {
    if (open) return;
    fontDiscoveryGeneration.current += 1;
    fontDiscoveryAttempted.current = false;
    setFontDiscovery({ status: 'idle' });
  }, [open]);

  const loadInstalledFonts = useCallback(async (): Promise<void> => {
    if (fontDiscoveryAttempted.current) return;
    fontDiscoveryAttempted.current = true;
    const generation = fontDiscoveryGeneration.current;
    setFontDiscovery({ status: 'loading' });
    const result = await discoverLocalFonts(window);
    if (fontDiscoveryGeneration.current === generation) {
      fontDiscoveryAttempted.current = false;
      setFontDiscovery(result);
    }
  }, []);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="settings-modal"
    >
      <div
        className="modal-panel relative flex h-[600px] max-h-[92vh] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-[--panel-strong] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="drag h-12 flex items-center justify-between pl-5 pr-2 shrink-0">
          <span className="text-sm font-semibold">Settings</span>
          <button
            type="button"
            onClick={onClose}
            className="no-drag flex min-h-11 min-w-11 items-center justify-center rounded-md text-[--text-muted] hover:bg-[--surface-hover] hover:text-[--text]"
            title="Close (Esc)"
            data-testid="settings-close"
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body: nav + panel */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="Settings sections" className="flex w-full shrink-0 gap-2 overflow-x-auto px-3 pb-3 sm:w-48 sm:flex-col sm:gap-1 sm:overflow-visible sm:pt-1">
            <SectionButton active={section === 'general'} onClick={() => setSection('general')}>General</SectionButton>
            <SectionButton active={section === 'roots'} onClick={() => setSection('roots')}>Root directories</SectionButton>
            <SectionButton active={section === 'launch'} onClick={() => setSection('launch')}>Launch commands</SectionButton>
            <SectionButton active={section === 'metaproject'} onClick={() => setSection('metaproject')}>Metaproject</SectionButton>
            <div className="mt-auto hidden px-2 pt-3 text-[10px] text-[--text-muted] sm:block">
              MetaLogix IDE · Phase 1
            </div>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6 sm:pt-1">
            {section === 'general' && (
              <GeneralPanel
                fontDiscovery={fontDiscovery}
                onLoadInstalledFonts={loadInstalledFonts}
              />
            )}
            {section === 'roots' && <RootsPanel />}
            {section === 'launch' && <LaunchPanel />}
            {section === 'metaproject' && <MetaprojectPanel />}
          </div>
        </div>

        {/* Footer */}
        <div className="h-14 flex items-center justify-end gap-2 px-4 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="pressable min-h-10 rounded-lg bg-[--accent-soft] px-5 text-sm font-medium text-[--accent-soft-text] hover:brightness-125"
            data-testid="settings-done"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SectionButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-10 shrink-0 rounded-lg px-3 py-2 text-left text-sm sm:w-full sm:px-2.5 ${
        active ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium' : 'hover:bg-[--surface-hover] text-[--text-muted] hover:text-[--text]'
      }`}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────── General ─────────────────────────────── */

function GeneralPanel({
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

/* ──────────────────────────────── Roots ──────────────────────────────── */

function RootsPanel() {
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

/* ─────────────────────────── Launch commands ─────────────────────────── */

const LAUNCH_KEYS: ReadonlyArray<keyof SettingsMap> = ['default_launch_cmd.first', 'default_launch_cmd.subsequent'];

function LaunchPanel() {
  const [first, setFirst]           = useState<LaunchCmd | null>(null);
  const [subsequent, setSubsequent] = useState<LaunchCmd | null>(null);
  const [modeBusy, setModeBusy]     = useState(false);
  const { mode, choose, error: modeError } = useClaudePermissionMode();

  const load = useCallback(async () => {
    const [f, s] = await Promise.all([
      api.invoke('settings:get', { key: 'default_launch_cmd.first' }),
      api.invoke('settings:get', { key: 'default_launch_cmd.subsequent' }),
    ]);
    setFirst(f.value as LaunchCmd);
    setSubsequent(s.value as LaunchCmd);
  }, []);

  useEffect(() => {
    void load();
    const off = api.on('settings:changed', ({ key }) => {
      if (LAUNCH_KEYS.includes(key)) void load();
    });
    return () => { off(); };
  }, [load]);

  async function changeMode(next: ClaudePermissionMode) {
    setModeBusy(true);
    try {
      await choose(next);
      await load();
    } finally {
      setModeBusy(false);
    }
  }

  async function saveFirst(value: LaunchCmd) {
    setFirst(value);
    await api.invoke('settings:set', { key: 'default_launch_cmd.first', value });
  }
  async function saveSubsequent(value: LaunchCmd) {
    setSubsequent(value);
    await api.invoke('settings:set', { key: 'default_launch_cmd.subsequent', value });
  }

  return (
    <div className="space-y-6">
      <Header
        title="Launch commands"
        subtitle="What runs when you open a project. First launch runs 'first'; subsequent launches use 'subsequent' (typically adds --continue)."
      />
      <Field label={PERMISSION_MODE_COPY.settingsLabel} hint={PERMISSION_MODE_COPY.settingsHint}>
        <PermissionModeControl mode={mode} disabled={modeBusy} onChange={(m) => void changeMode(m)} />
        {modeError && <div role="alert" className="text-xs text-[--danger]">{modeError}</div>}
      </Field>
      {first && <LaunchEditor label="First launch" value={first} onChange={saveFirst} testId={PERMISSION_MODE_TEST_IDS.launchEditorFirst} />}
      {subsequent && <LaunchEditor label="Subsequent launches" value={subsequent} onChange={saveSubsequent} testId={PERMISSION_MODE_TEST_IDS.launchEditorSubsequent} />}
      <div className="text-xs text-[--text-muted] leading-relaxed">
        Tokens supported: <code>${'{HOME}'}</code>, <code>${'{PROJECT_PATH}'}</code>, <code>${'{PROJECT_NAME}'}</code>, <code>${'{env.NAME}'}</code>.
        Interpolation is per-argv-element, so tokens cannot introduce new arguments.
      </div>
    </div>
  );
}

function LaunchEditor({ label, value, onChange, testId }: { label: string; value: LaunchCmd; onChange: (v: LaunchCmd) => void; testId: string }) {
  const [argvText, setArgvText] = useState(value.argv.join(' '));
  useEffect(() => { setArgvText(value.argv.join(' ')); }, [value]);

  function commit() {
    // Simple shell-like split preserving quoted strings.
    const argv = parseArgv(argvText);
    if (argv.length === 0) return;
    onChange({ ...value, argv });
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-[--text-muted] uppercase tracking-wider">{label}</div>
      <input
        value={argvText}
        onChange={(e) => setArgvText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
        className="w-full font-mono text-sm bg-[--surface-field] text-[--text] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[--accent]/60"
        placeholder='e.g. claude --permission-mode auto'
        aria-label={label}
        data-testid={testId}
      />
      <div className="text-[11px] text-[--text-muted]">argv: <span className="font-mono">{JSON.stringify(value.argv)}</span></div>
    </div>
  );
}

/* ─────────────────────────── Metaproject ─────────────────────────── */

function MetaprojectPanel() {
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

/* ────────────────────────────── primitives ───────────────────────────── */

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-[--text-muted]">{subtitle}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="text-xs text-[--text-muted]">{hint}</div>}
      {children}
    </div>
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

