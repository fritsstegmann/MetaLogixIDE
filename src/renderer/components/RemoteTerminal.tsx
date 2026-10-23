/** Fleet terminals share local shell chrome while PTY control stays on the linked machine. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { createTerminalKeyHandler } from '@renderer/terminal-keys';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
import { buildFontFamilyStack } from '@renderer/fonts/font-family';
import { useFontSettings } from '@renderer/fonts/font-settings-context';
import { useTerminalFontSize } from '@renderer/fonts/terminal-font-size-context';
import { useTerminalFontWeight } from '@renderer/fonts/terminal-font-weight-context';
import { terminalFontWeightOptions } from '@renderer/terminal-font-weight-apply';
import { FROST_ATTR } from '@renderer/frosted-chrome-contract';
import { TERMINAL_FONT_FALLBACK } from '@shared/font-settings';
import { TERMINAL_SCROLLBACK_LINES } from '@shared/terminal-scrollback';
import type { FleetTerminalEvent } from '@shared/fleet-contract';
import type { FleetShell } from '@shared/fleet-contract';
import { StatusDot } from './StatusDot';
import { ShellTabsBar, type RemoteShellMenu, type ShellTabsBarItem } from './ShellTabsBar';
import { XIcon } from './shell-icons';
import type { RemoteProjectSelection } from './Sidebar';

const BUTTON = 'h-7 rounded-md px-2 text-xs text-[--text-muted] hover:bg-[--panel-strong] hover:text-[--text] focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-40';
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const REMOTE_LAUNCH_ERRORS = [
  'Choose a Claude permission mode on the remote machine first',
  'Claude is unavailable on the remote machine',
  'Remote shell limit reached; unpin a shell or raise the cap',
  'Remote project folder is unavailable',
] as const;
const MAX_PENDING_EVENTS = 2048;
type Session = { kind: 'starting' } | { kind: 'connecting'; shellIndex: number } | { kind: 'running'; shellIndex: number } | { kind: 'exited'; shellIndex: number } | { kind: 'error'; message: string };

/** A request to show one shell; a new `seq` asks again for the same index. */
export interface RemoteShellFocus {
  readonly shellIndex: number;
  readonly seq: number;
}

/** The project's live shell count and the shell on screen, null while none is attached or the peer is offline. */
export interface RemoteShellsState {
  readonly count: number;
  readonly shownShellIndex: number | null;
}

interface Props {
  readonly project: RemoteProjectSelection;
  readonly available: boolean;
  readonly onRefreshAvailability: () => void;
  /** Selects this shell once it is listed on the peer, for example after a notice click. */
  readonly focusShell?: RemoteShellFocus | null;
  /** Reports shell count and shown shell whenever either changes; reuses the 4 s `fleet:status` poll. */
  readonly onShellsChange?: (state: RemoteShellsState) => void;
}

function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: 'rgba(0,0,0,0)', foreground: color('--term-fg', '#e6edf3'),
    cursor: color('--term-cursor', '#e6edf3'), selectionBackground: color('--term-selection', 'rgba(255,255,255,0.2)'),
    black: color('--term-black', '#000000'), red: color('--term-red', '#cd0000'),
    green: color('--term-green', '#00cd00'), yellow: color('--term-yellow', '#cdcd00'),
    blue: color('--term-blue', '#0000ee'), magenta: color('--term-magenta', '#cd00cd'),
    cyan: color('--term-cyan', '#00cdcd'), white: color('--term-white', '#e5e5e5'),
    brightBlack: color('--term-bright-black', '#7f7f7f'), brightRed: color('--term-bright-red', '#ff0000'),
    brightGreen: color('--term-bright-green', '#00ff00'), brightYellow: color('--term-bright-yellow', '#ffff00'),
    brightBlue: color('--term-bright-blue', '#5c5cff'), brightMagenta: color('--term-bright-magenta', '#ff00ff'),
    brightCyan: color('--term-bright-cyan', '#00ffff'), brightWhite: color('--term-bright-white', '#ffffff'),
  };
}

function* terminalChunks(data: string): Generator<string> {
  const bytes = new TextEncoder().encode(data);
  const decoder = new TextDecoder();
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 4096, bytes.length);
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    yield decoder.decode(bytes.subarray(start, end));
    start = end;
  }
}

/** Attaches only the active remote PTY; its other shells stay alive on the peer. */
export function RemoteTerminal({ project, available, onRefreshAvailability, focusShell = null, onShellsChange }: Props) {
  const { peerId, peerName, projectId, projectName } = project;
  const [session, setSession] = useState<Session>({ kind: 'starting' });
  const [shellIndex, setShellIndex] = useState<number | null>(null);
  const [shells, setShells] = useState<readonly FleetShell[]>([]);
  const [defaultCliName, setDefaultCliName] = useState<string | null>(null);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const [stopping, setStopping] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const mounted = useRef(true);
  const focusRef = useRef(focusShell);
  focusRef.current = focusShell;
  const handledFocus = useRef<number | null>(null);
  const platform = useShortcutPlatform();
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const { terminalFontFamily } = useFontSettings();
  const { size: fontSize } = useTerminalFontSize();
  const { weight, boldWeight } = useTerminalFontWeight();
  const fontRef = useRef({ terminalFontFamily, fontSize, weight, boldWeight });
  fontRef.current = { terminalFontFamily, fontSize, weight, boldWeight };

  const refreshShells = useCallback(async () => {
    const request = ++statusRequest.current;
    const status = await api.invoke('fleet:status', { peerId });
    if (!mounted.current || statusRequest.current !== request) return null;
    const projectShells = status.shells.filter((shell) => shell.projectId === projectId);
    setShells(projectShells);
    return projectShells;
  }, [peerId, projectId]);

  const launch = useCallback(async (kind: 'claude' | 'plain' | 'cli', request?: { profileName?: string; argv?: string[]; save?: boolean }) => {
    if (!available) return;
    const attempt = ++generation.current;
    setStopping(false);
    setSession({ kind: 'starting' });
    try {
      const result = kind === 'claude'
        ? await api.invoke('fleet:launch-claude', { peerId, projectId })
        : kind === 'plain'
          ? await api.invoke('fleet:launch', { peerId, projectId })
          : await api.invoke('fleet:launch-cli', { peerId, projectId, ...request });
      if (mounted.current && generation.current === attempt) {
        runningRef.current = false;
        setSession({ kind: 'connecting', shellIndex: result.shellIndex });
        setAttachmentEpoch((epoch) => epoch + 1);
        setShellIndex(result.shellIndex);
        void refreshShells().catch(() => undefined);
      }
    } catch (error) {
      if (mounted.current && generation.current === attempt) {
        const reason = error instanceof Error
          ? REMOTE_LAUNCH_ERRORS.find((known) => error.message.endsWith(known))
          : undefined;
        setSession({ kind: 'error', message: reason ??
          `Could not open ${kind === 'claude' ? 'Claude' : kind === 'plain' ? 'a plain shell' : 'the selected CLI'} on ${peerName}. Check the connection and remote launch settings, then retry.` });
      }
    }
  }, [available, peerId, peerName, projectId, refreshShells]);

  useEffect(() => {
    const currentGeneration = generation;
    const currentStatusRequest = statusRequest;
    let active = true;
    mounted.current = true;
    const attempt = ++generation.current;
    if (available) {
      void refreshShells().then((existing) => {
        if (!existing || !mounted.current || generation.current !== attempt) return;
        if (existing.length > 0) {
          const requested = focusRef.current;
          const wanted = requested && existing.some((shell) => shell.shellIndex === requested.shellIndex) ? requested : null;
          if (wanted) handledFocus.current = wanted.seq;
          const index = wanted?.shellIndex ?? existing.find((shell) => shell.shellIndex === 0)?.shellIndex ?? existing[0]!.shellIndex;
          setShellIndex(index);
          setSession({ kind: 'connecting', shellIndex: index });
        } else void launch('claude');
      }).catch(() => {
        if (mounted.current && generation.current === attempt)
          setSession({ kind: 'error', message: `Could not load shells on ${peerName}. Check the connection and retry.` });
      });
      void api.invoke('fleet:profiles', { peerId, projectId }).then(({ defaultCliName }) => {
        if (active) setDefaultCliName(defaultCliName);
      }).catch(() => undefined);
    } else {
      runningRef.current = false;
      setShellIndex(null);
    }
    return () => { active = false; currentStatusRequest.current++; mounted.current = false; currentGeneration.current++; runningRef.current = false; };
  }, [available, launch, peerId, peerName, projectId, refreshShells]);

  useEffect(() => {
    if (!available) return;
    const timer = setInterval(() => { void refreshShells().catch(() => undefined); }, 4000);
    return () => clearInterval(timer);
  }, [available, refreshShells]);

  useEffect(() => {
    if (!available || shellIndex === null || !hostRef.current) return;
    const host = hostRef.current;
    const font = fontRef.current;
    const term = new Terminal({
      scrollback: TERMINAL_SCROLLBACK_LINES, fontFamily: buildFontFamilyStack(font.terminalFontFamily, TERMINAL_FONT_FALLBACK),
      fontSize: font.fontSize, ...terminalFontWeightOptions({ weight: font.weight, boldWeight: font.boldWeight }),
      lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar', theme: terminalTheme(),
      allowProposedApi: true, minimumContrastRatio: 1,
    });
    terminalRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    let active = true;
    let opened = false;
    let exited = false;
    let subscriptionId: string | null = null;
    let pending: FleetTerminalEvent[] = [];
    let pendingBytes = 0;
    let writeQueue = Promise.resolve();
    let lastSize: { cols: number; rows: number } | null = null;
    const detach = () => {
      active = false;
      runningRef.current = false;
      if (subscriptionId) {
        void api.invoke('fleet:unsubscribe', { peerId, subscriptionId }).catch(() => undefined);
        subscriptionId = null;
      }
    };
    const resize = () => {
      if (!active || !opened || exited || host.clientWidth < 20 || host.clientHeight < 20) return;
      fit.fit();
      if (!subscriptionId || (lastSize !== null && lastSize.cols === term.cols && lastSize.rows === term.rows)) return;
      lastSize = { cols: term.cols, rows: term.rows };
      void api.invoke('fleet:resize', { peerId, projectId, shellIndex, cols: term.cols, rows: term.rows }).catch(() => {
        if (active && !exited) {
          detach();
          setSession({ kind: 'error', message: 'Could not resize remote terminal. Check the connection and retry.' });
        }
      });
    };
    resizeRef.current = resize;
    const applyEvent = (event: FleetTerminalEvent) => {
      if (!active || exited || event.subscriptionId !== subscriptionId) return;
      if (event.kind === 'snapshot' || event.kind === 'data') term.write(event.data);
      if (event.kind === 'ready') {
        runningRef.current = true;
        setSession({ kind: 'running', shellIndex });
        term.focus();
      }
      if (event.kind === 'exit') {
        exited = true;
        detach();
        setSession({ kind: 'exited', shellIndex });
      }
    };
    const off = api.on('fleet:terminal', (event) => {
      if (!active || event.peerId !== peerId || event.projectId !== projectId || event.shellIndex !== shellIndex) return;
      if (subscriptionId) { applyEvent(event); return; }
      pendingBytes += event.data.length;
      if (pendingBytes > MAX_PENDING_BYTES || pending.length >= MAX_PENDING_EVENTS) {
        pending = [];
        detach();
        setSession({ kind: 'error', message: 'Remote terminal output exceeded the attachment buffer. Retry to reconnect.' });
        return;
      }
      pending.push(event);
    });
    const dataListener = term.onData((data) => {
      if (!active || !runningRef.current) return;
      for (const chunk of terminalChunks(data)) {
        writeQueue = writeQueue.then(async () => {
          if (active && runningRef.current) await api.invoke('fleet:write', { peerId, projectId, shellIndex, data: chunk });
        }).catch(() => {
          if (active) {
            detach();
            setSession({ kind: 'error', message: 'Could not send input to the remote machine. Check the connection and retry.' });
          }
        });
      }
    });
    term.attachCustomKeyEventHandler(createTerminalKeyHandler({
      platform: platformRef.current,
      hasSelection: () => term.hasSelection(),
      getSelection: () => term.getSelection(),
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      readClipboard: () => navigator.clipboard.readText(),
      paste: (text) => { if (active && runningRef.current) term.paste(text); },
      onClipboardError: () => {
        if (active) toast('Remote terminal clipboard failed', { kind: 'error', detail: 'Check clipboard access and retry.' });
      },
    }));
    const subscribe = () => {
      void api.invoke('fleet:subscribe', { peerId, projectId, shellIndex }).then((result) => {
        subscriptionId = result.subscriptionId;
        if (!active) {
          detach();
          return;
        }
        resize();
        for (const event of pending) applyEvent(event);
        pending = [];
        pendingBytes = 0;
      }).catch(() => {
        if (active) {
          detach();
          setSession({ kind: 'error', message: 'Could not attach remote terminal. Check the connection and retry.' });
        }
      });
    };
    let fontsReady = false;
    const open = () => {
      if (!active || opened || !fontsReady || host.clientWidth < 20 || host.clientHeight < 20) return;
      term.open(host);
      opened = true;
      resize();
      subscribe();
    };
    const observer = new ResizeObserver(() => { open(); resize(); });
    observer.observe(host);
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', FROST_ATTR.platform, FROST_ATTR.chromeFrost, FROST_ATTR.terminalFrost] });
    const markFontsReady = () => {
      fontsReady = true;
      clearTimeout(fontTimeout);
      open();
    };
    const fontTimeout = setTimeout(markFontsReady, 1500);
    if (document.fonts) void document.fonts.ready.then(markFontsReady, markFontsReady);
    else markFontsReady();
    return () => {
      detach();
      clearTimeout(fontTimeout);
      pending = [];
      off();
      observer.disconnect();
      themeObserver.disconnect();
      dataListener.dispose();
      term.dispose();
      if (resizeRef.current === resize) resizeRef.current = null;
      if (terminalRef.current === term) terminalRef.current = null;
    };
  }, [available, peerId, projectId, shellIndex, attachmentEpoch]);

  useEffect(() => {
    if (!focusShell || handledFocus.current === focusShell.seq || !shells.some((shell) => shell.shellIndex === focusShell.shellIndex)) return;
    handledFocus.current = focusShell.seq;
    if (focusShell.shellIndex === shellIndex) return;
    runningRef.current = false;
    setSession({ kind: 'connecting', shellIndex: focusShell.shellIndex });
    setShellIndex(focusShell.shellIndex);
  }, [focusShell, shells, shellIndex]);

  const shownShellIndex = available ? shellIndex : null;
  useEffect(() => {
    onShellsChange?.({ count: shells.length, shownShellIndex });
  }, [onShellsChange, shells.length, shownShellIndex]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontFamily = buildFontFamilyStack(terminalFontFamily, TERMINAL_FONT_FALLBACK);
    term.options.fontSize = fontSize;
    const options = terminalFontWeightOptions({ weight, boldWeight });
    term.options.fontWeight = options.fontWeight;
    term.options.fontWeightBold = options.fontWeightBold;
    resizeRef.current?.();
  }, [terminalFontFamily, fontSize, weight, boldWeight]);

  async function stop(index = shellIndex) {
    if (index === null || !available || stopping) return;
    const attempt = generation.current;
    setStopping(true);
    try {
      await api.invoke('fleet:stop', { peerId, projectId, shellIndex: index });
      if (mounted.current && generation.current === attempt) {
        const remaining = shells.filter((shell) => shell.shellIndex !== index);
        setShells(remaining);
        if (shellIndex === index) {
          runningRef.current = false;
          const next = remaining.find((shell) => shell.shellIndex === 0) ?? remaining[0];
          setShellIndex(next?.shellIndex ?? null);
          setSession(next ? { kind: 'connecting', shellIndex: next.shellIndex } : { kind: 'exited', shellIndex: index });
        }
      }
    } catch {
      if (mounted.current && generation.current === attempt) setSession({ kind: 'error', message: 'Could not stop remote shell. Check the connection and retry.' });
    } finally {
      if (mounted.current && generation.current === attempt) setStopping(false);
    }
  }

  async function paste() {
    if (!runningRef.current) return;
    try {
      const text = await navigator.clipboard.readText();
      if (runningRef.current) terminalRef.current?.paste(text);
    } catch {
      if (runningRef.current) setSession({ kind: 'error', message: 'Could not read clipboard. Allow clipboard access and retry.' });
    }
  }

  function select(index: number) {
    if (index === shellIndex) return;
    runningRef.current = false;
    setSession({ kind: 'connecting', shellIndex: index });
    setShellIndex(index);
  }

  function launchCustom(name: string, cmdLine: string, save: boolean) {
    const argv: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(cmdLine)) !== null) argv.push(match[1] ?? match[2] ?? '');
    if (argv.length === 0) return;
    void launch('cli', { profileName: name || undefined, argv, save });
  }

  const remoteMenu = useMemo<RemoteShellMenu>(() => ({
    profiles: async () => (await api.invoke('fleet:profiles', { peerId, projectId })).profiles,
    remove: async (name) => { await api.invoke('fleet:remove-cli-profile', { peerId, projectId, name }); },
    setDefault: async (name) => {
      const result = await api.invoke('fleet:set-default-cli', { peerId, projectId, name });
      setDefaultCliName(result.defaultCliName);
    },
  }), [peerId, projectId]);

  return (
    <section aria-label={`Remote project ${projectName} on ${peerName}`} data-testid="remote-workspace" className="flex h-full min-h-0 min-w-0 flex-col text-[--text]">
      <header className="flex flex-wrap items-center gap-1 px-2 pt-1.5 pb-1 text-xs shrink-0">
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 pr-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[--text] pl-2 pr-1 py-0.5 rounded-md bg-[--surface-active] text-[11px] max-w-[280px]" title={`${projectName} on ${peerName}`}>
            <StatusDot state={shells.find((shell) => shell.shellIndex === shellIndex)?.state ?? 'idle'} />
            <span className="truncate font-medium">{projectName} · {peerName}</span>
            <button type="button" onClick={() => void stop()} disabled={!available || shellIndex === null || stopping}
              className="ml-1 text-[--text-muted] hover:text-[--danger] hover:bg-[--panel]/60 w-4 h-4 flex items-center justify-center rounded disabled:opacity-40"
              title="Stop remote shell" aria-label="Stop remote shell">
              <XIcon />
            </button>
          </span>
          {!available && <button type="button" className={BUTTON} onClick={onRefreshAvailability}>Refresh connection</button>}
          <button type="button" className={BUTTON} disabled={!available || session.kind === 'starting'} onClick={() => {
            if (shellIndex === null) void launch('claude');
            else { setSession({ kind: 'connecting', shellIndex }); setAttachmentEpoch((epoch) => epoch + 1); }
          }}>Reconnect terminal</button>
          <button type="button" className={BUTTON} disabled={!available || session.kind !== 'running'} onClick={() => void paste()}>Paste</button>
        </div>
      </header>
      {available && (
        <ShellTabsBar
          projectId={projectId}
          shells={shells}
          active={shellIndex ?? -1}
          onSelect={select}
          onClose={(index) => void stop(index)}
          defaultCliName={defaultCliName}
          remoteMenu={remoteMenu}
          renderDot={(item: ShellTabsBarItem, active: boolean) =>
            <StatusDot state={item.state ?? 'idle'} agent={item.agent} inactiveWhenIdle={!active} />}
          onLaunchProfile={(name) => void launch('cli', { profileName: name })}
          onLaunchPlainTab={() => void launch('plain')}
          onLaunchCustom={launchCustom}
        />
      )}
      {!available && <p role="alert" className="p-4 text-base text-[--danger]">{peerName} is offline or unlinked. Reconnect or relink it to resume the terminal.</p>}
      {available && session.kind === 'starting' && <p role="status" className="p-4 text-base">Opening terminal on {peerName}…</p>}
      {available && session.kind === 'connecting' && <p role="status" className="p-4 text-base">Attaching terminal on {peerName}…</p>}
      {available && session.kind === 'error' && <p role="alert" className="p-4 text-base text-[--danger]">{session.message}</p>}
      {available && session.kind === 'exited' && <p role="status" className="p-4 text-base">Remote terminal ended. Choose a CLI or reconnect to start a session.</p>}
      {available && shellIndex !== null && (
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-3">
          <div ref={hostRef} role="region" aria-label={`Terminal for ${projectName} on ${peerName}`} className="h-full w-full min-w-0 isolate" />
        </div>
      )}
    </section>
  );
}
