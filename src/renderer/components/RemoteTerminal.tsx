/** A remote Claude attachment renders the Fleet PTY stream in xterm without local project APIs. */
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { FleetTerminalEvent } from '@shared/fleet-contract';
import type { RemoteProjectSelection } from './Sidebar';

const BUTTON = 'min-h-11 rounded-lg border border-[--border] px-3 text-base text-[--text] hover:bg-[--surface-hover] focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 disabled:opacity-50';
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const REMOTE_LAUNCH_ERRORS = [
  'Choose a Claude permission mode on the remote machine first',
  'Claude is unavailable on the remote machine',
  'Remote shell limit reached; unpin a shell or raise the cap',
  'Remote project folder is unavailable',
] as const;
const MAX_PENDING_EVENTS = 2048;
type Session = { kind: 'starting' } | { kind: 'connecting'; shellIndex: number } | { kind: 'running'; shellIndex: number } | { kind: 'exited'; shellIndex: number } | { kind: 'error'; message: string };

interface Props {
  readonly project: RemoteProjectSelection;
  readonly available: boolean;
  readonly onRefreshAvailability: () => void;
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

/** Launches or reattaches remote Claude and owns one cancellable streamed terminal subscription. */
export function RemoteTerminal({ project, available, onRefreshAvailability }: Props) {
  const { peerId, peerName, projectId, projectName } = project;
  const [session, setSession] = useState<Session>({ kind: 'starting' });
  const [shellIndex, setShellIndex] = useState<number | null>(null);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const [stopping, setStopping] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const platform = useShortcutPlatform();
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const { terminalFontFamily } = useFontSettings();
  const { size: fontSize } = useTerminalFontSize();
  const { weight, boldWeight } = useTerminalFontWeight();
  const fontRef = useRef({ terminalFontFamily, fontSize, weight, boldWeight });
  fontRef.current = { terminalFontFamily, fontSize, weight, boldWeight };

  const launch = useCallback(async (kind: 'claude' | 'plain') => {
    if (!available) return;
    const attempt = ++generation.current;
    runningRef.current = false;
    setStopping(false);
    setShellIndex(null);
    setSession({ kind: 'starting' });
    try {
      const result = kind === 'claude'
        ? await api.invoke('fleet:launch-claude', { peerId, projectId })
        : await api.invoke('fleet:launch', { peerId, projectId });
      if (mounted.current && generation.current === attempt) {
        setSession({ kind: 'connecting', shellIndex: result.shellIndex });
        setAttachmentEpoch(attempt);
        setShellIndex(result.shellIndex);
      }
    } catch (error) {
      if (mounted.current && generation.current === attempt) {
        const reason = error instanceof Error
          ? REMOTE_LAUNCH_ERRORS.find((known) => error.message.endsWith(known))
          : undefined;
        setSession({ kind: 'error', message: reason ??
          `Could not open ${kind === 'claude' ? 'Claude' : 'a plain shell'} on ${peerName}. Check the connection and remote launch settings, then retry.` });
      }
    }
  }, [available, peerId, peerName, projectId]);

  useEffect(() => {
    const currentGeneration = generation;
    mounted.current = true;
    if (available) void launch('claude');
    else {
      generation.current++;
      runningRef.current = false;
      setShellIndex(null);
    }
    return () => { mounted.current = false; currentGeneration.current++; runningRef.current = false; };
  }, [launch, available]);

  useEffect(() => {
    if (!available || shellIndex === null || !hostRef.current) return;
    const host = hostRef.current;
    const font = fontRef.current;
    const term = new Terminal({
      scrollback: 10000, fontFamily: buildFontFamilyStack(font.terminalFontFamily, TERMINAL_FONT_FALLBACK),
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
    const resize = () => {
      if (!active || !opened || exited || host.clientWidth < 20 || host.clientHeight < 20) return;
      fit.fit();
      void api.invoke('fleet:resize', { peerId, projectId, shellIndex, cols: term.cols, rows: term.rows }).catch(() => {
        if (active && !exited) { runningRef.current = false; setSession({ kind: 'error', message: 'Could not resize remote terminal. Check the connection and retry.' }); }
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
        runningRef.current = false;
        setSession({ kind: 'exited', shellIndex });
      }
    };
    const off = api.on('fleet:terminal', (event) => {
      if (!active || event.peerId !== peerId || event.projectId !== projectId || event.shellIndex !== shellIndex) return;
      if (subscriptionId) { applyEvent(event); return; }
      pendingBytes += event.data.length;
      if (pendingBytes > MAX_PENDING_BYTES || pending.length >= MAX_PENDING_EVENTS) {
        pending = [];
        active = false;
        runningRef.current = false;
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
          if (active) { runningRef.current = false; setSession({ kind: 'error', message: 'Could not send input to the remote machine. Check the connection and retry.' }); }
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
          void api.invoke('fleet:unsubscribe', { peerId, subscriptionId }).catch(() => undefined);
          return;
        }
        for (const event of pending) applyEvent(event);
        pending = [];
        pendingBytes = 0;
      }).catch(() => {
        if (active) { runningRef.current = false; setSession({ kind: 'error', message: 'Could not attach remote terminal. Check the connection and retry.' }); }
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
      active = false;
      clearTimeout(fontTimeout);
      runningRef.current = false;
      pending = [];
      off();
      observer.disconnect();
      themeObserver.disconnect();
      dataListener.dispose();
      term.dispose();
      if (resizeRef.current === resize) resizeRef.current = null;
      if (terminalRef.current === term) terminalRef.current = null;
      if (subscriptionId) void api.invoke('fleet:unsubscribe', { peerId, subscriptionId }).catch(() => undefined);
    };
  }, [available, peerId, projectId, shellIndex, attachmentEpoch]);

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

  async function stop() {
    if (shellIndex === null || !available || stopping) return;
    const attempt = generation.current;
    setStopping(true);
    try {
      await api.invoke('fleet:stop', { peerId, projectId, shellIndex });
      if (mounted.current && generation.current === attempt) {
        runningRef.current = false;
        setSession({ kind: 'exited', shellIndex });
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

  return (
    <section aria-label={`Remote project ${projectName} on ${peerName}`} data-testid="remote-workspace" className="flex h-full min-h-0 min-w-0 flex-col text-[--text]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[--border] px-4 py-2">
        <div className="min-w-0"><h2 className="truncate text-base font-semibold">{projectName}</h2><p className="text-sm text-[--text-muted]">Claude on {peerName}</p></div>
        <div className="flex flex-wrap gap-2">
          {!available && <button type="button" className={BUTTON} onClick={onRefreshAvailability}>Refresh connection</button>}
          <button type="button" className={BUTTON} disabled={!available || session.kind === 'starting'} onClick={() => void launch('claude')}>Retry Claude</button>
          <button type="button" className={BUTTON} disabled={!available || session.kind === 'starting'} onClick={() => void launch('plain')}>New plain shell</button>
          <button type="button" className={BUTTON} disabled={!available || shellIndex === null || session.kind === 'exited' || stopping} onClick={() => void stop()}>Stop remote shell</button>
          <button type="button" className={BUTTON} disabled={!available || session.kind !== 'running'} onClick={() => void paste()}>Paste</button>
        </div>
      </header>
      {!available && <p role="alert" className="p-4 text-base text-[--danger]">{peerName} is offline or unlinked. Reconnect or relink it to resume Claude.</p>}
      {available && session.kind === 'starting' && <p role="status" className="p-4 text-base">Opening Claude on {peerName}…</p>}
      {available && session.kind === 'connecting' && <p role="status" className="p-4 text-base">Attaching terminal on {peerName}…</p>}
      {available && session.kind === 'error' && <p role="alert" className="p-4 text-base text-[--danger]">{session.message}</p>}
      {available && session.kind === 'exited' && <p role="status" className="p-4 text-base">Remote terminal ended. Retry Claude to reconnect or start a session.</p>}
      {available && shellIndex !== null && (
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-3">
          <div ref={hostRef} role="region" aria-label={`Terminal for ${projectName} on ${peerName}`} className="h-full w-full min-w-0 isolate" />
        </div>
      )}
    </section>
  );
}
