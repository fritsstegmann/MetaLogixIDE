import { useCallback, useEffect, useState } from 'react';
import type { LaunchCmd, SettingsMap } from '@shared/types';
import { parseArgv } from '@shared/parse-argv';
import { api } from '@renderer/api';
import { useClaudePermissionMode } from '@renderer/hooks/useClaudePermissionMode';
import { PermissionModeControl } from '@renderer/components/PermissionModeControl';
import { PERMISSION_MODE_COPY, PERMISSION_MODE_TEST_IDS } from '@renderer/permission-mode-copy';
import type { ClaudePermissionMode } from '@shared/claude-permission-mode';
import { Field, Header } from '@renderer/components/settings/primitives';

const LAUNCH_KEYS: ReadonlyArray<keyof SettingsMap> = ['default_launch_cmd.first', 'default_launch_cmd.subsequent'];

/** Launch commands settings panel. */
export function LaunchPanel() {
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
