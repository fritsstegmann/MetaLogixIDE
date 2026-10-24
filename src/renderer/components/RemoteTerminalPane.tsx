/**
 * One remote terminal attachment: an xterm bound to a single shell on a linked peer. It subscribes
 * once fonts are loaded and the host has a measurable size, buffers events until the subscription
 * is acknowledged, forwards input as ordered UTF-8-safe chunks, resizes the PTY only when the
 * fitted geometry changes, routes copy/paste keys and write-only OSC 52 to the local clipboard,
 * and reports `running`, `exited` and `error` to its owner. Each pane is independent, so a split
 * shows two of them side by side.
 */
import { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { createTerminalKeyHandler } from '@renderer/terminal-keys';
import { installOsc52 } from '@renderer/terminal-osc52';
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

const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_EVENTS = 2048;

/** What a pane reports about its attachment; `error` carries the safe message to show. */
export type RemotePaneStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited' }
  | { readonly kind: 'error'; readonly message: string };

/** Imperative access the owner uses for its Paste button. */
export interface RemoteTerminalPaneControl {
  readonly isRunning: () => boolean;
  readonly paste: (text: string) => void;
}

interface Props {
  readonly peerId: string;
  readonly projectId: number;
  readonly shellIndex: number;
  /** Bump to drop the subscription and reattach the same shell. */
  readonly epoch: number;
  readonly label: string;
  readonly onStatus: (status: RemotePaneStatus, shellIndex: number) => void;
  readonly control?: { current: RemoteTerminalPaneControl | null };
}

function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: 'rgba(0,0,0,0)',
    foreground: color('--term-fg', '#e6edf3'),
    cursor: color('--term-cursor', '#e6edf3'),
    selectionBackground: color('--term-selection', 'rgba(255,255,255,0.2)'),
    black: color('--term-black', '#000000'),
    red: color('--term-red', '#cd0000'),
    green: color('--term-green', '#00cd00'),
    yellow: color('--term-yellow', '#cdcd00'),
    blue: color('--term-blue', '#0000ee'),
    magenta: color('--term-magenta', '#cd00cd'),
    cyan: color('--term-cyan', '#00cdcd'),
    white: color('--term-white', '#e5e5e5'),
    brightBlack: color('--term-bright-black', '#7f7f7f'),
    brightRed: color('--term-bright-red', '#ff0000'),
    brightGreen: color('--term-bright-green', '#00ff00'),
    brightYellow: color('--term-bright-yellow', '#ffff00'),
    brightBlue: color('--term-bright-blue', '#5c5cff'),
    brightMagenta: color('--term-bright-magenta', '#ff00ff'),
    brightCyan: color('--term-bright-cyan', '#00ffff'),
    brightWhite: color('--term-bright-white', '#ffffff'),
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

/** Renders the terminal region for `shellIndex` and owns its whole attachment lifecycle. */
export function RemoteTerminalPane({
  peerId,
  projectId,
  shellIndex,
  epoch,
  label,
  onStatus,
  control,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const controlRef = useRef(control);
  controlRef.current = control;
  const platform = useShortcutPlatform();
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const { terminalFontFamily } = useFontSettings();
  const { size: fontSize } = useTerminalFontSize();
  const { weight, boldWeight } = useTerminalFontWeight();
  const fontRef = useRef({ terminalFontFamily, fontSize, weight, boldWeight });
  fontRef.current = { terminalFontFamily, fontSize, weight, boldWeight };

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const font = fontRef.current;
    const report = (status: RemotePaneStatus) => statusRef.current(status, shellIndex);
    const term = new Terminal({
      scrollback: TERMINAL_SCROLLBACK_LINES,
      fontFamily: buildFontFamilyStack(font.terminalFontFamily, TERMINAL_FONT_FALLBACK),
      fontSize: font.fontSize,
      ...terminalFontWeightOptions({ weight: font.weight, boldWeight: font.boldWeight }),
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: terminalTheme(),
      allowProposedApi: true,
      minimumContrastRatio: 1,
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
    runningRef.current = false;
    const detach = () => {
      active = false;
      runningRef.current = false;
      if (subscriptionId) {
        void api.invoke('fleet:unsubscribe', { peerId, subscriptionId }).catch(() => undefined);
        subscriptionId = null;
      }
    };
    const fail = (message: string) => {
      detach();
      report({ kind: 'error', message });
    };
    const resize = () => {
      if (!active || !opened || exited || host.clientWidth < 20 || host.clientHeight < 20) return;
      fit.fit();
      if (
        !subscriptionId ||
        (lastSize !== null && lastSize.cols === term.cols && lastSize.rows === term.rows)
      )
        return;
      lastSize = { cols: term.cols, rows: term.rows };
      void api
        .invoke('fleet:resize', { peerId, projectId, shellIndex, cols: term.cols, rows: term.rows })
        .catch(() => {
          if (active && !exited)
            fail('Could not resize remote terminal. Check the connection and retry.');
        });
    };
    resizeRef.current = resize;
    const applyEvent = (event: FleetTerminalEvent) => {
      if (!active || exited || event.subscriptionId !== subscriptionId) return;
      if (event.kind === 'snapshot' || event.kind === 'data') term.write(event.data);
      if (event.kind === 'ready') {
        runningRef.current = true;
        report({ kind: 'running' });
        term.focus();
      }
      if (event.kind === 'exit') {
        exited = true;
        detach();
        report({ kind: 'exited' });
      }
    };
    const off = api.on('fleet:terminal', (event) => {
      if (
        !active ||
        event.peerId !== peerId ||
        event.projectId !== projectId ||
        event.shellIndex !== shellIndex
      )
        return;
      if (subscriptionId) {
        applyEvent(event);
        return;
      }
      pendingBytes += event.data.length;
      if (pendingBytes > MAX_PENDING_BYTES || pending.length >= MAX_PENDING_EVENTS) {
        pending = [];
        fail('Remote terminal output exceeded the attachment buffer. Retry to reconnect.');
        return;
      }
      pending.push(event);
    });
    const dataListener = term.onData((data) => {
      if (!active || !runningRef.current) return;
      for (const chunk of terminalChunks(data)) {
        writeQueue = writeQueue
          .then(async () => {
            if (active && runningRef.current)
              await api.invoke('fleet:write', { peerId, projectId, shellIndex, data: chunk });
          })
          .catch(() => {
            if (active)
              fail('Could not send input to the remote machine. Check the connection and retry.');
          });
      }
    });
    const onClipboardError = () => {
      if (active)
        toast('Remote terminal clipboard failed', {
          kind: 'error',
          detail: 'Check clipboard access and retry.',
        });
    };
    term.attachCustomKeyEventHandler(
      createTerminalKeyHandler({
        platform: platformRef.current,
        hasSelection: () => term.hasSelection(),
        getSelection: () => term.getSelection(),
        writeClipboard: (text) => navigator.clipboard.writeText(text),
        readClipboard: () => navigator.clipboard.readText(),
        paste: (text) => {
          if (active && runningRef.current) term.paste(text);
        },
        onClipboardError,
      }),
    );
    const osc52 = installOsc52(term, {
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      onError: onClipboardError,
    });
    const handle: RemoteTerminalPaneControl = {
      isRunning: () => active && runningRef.current,
      paste: (text) => {
        if (active && runningRef.current) term.paste(text);
      },
    };
    const owner = controlRef.current;
    if (owner) owner.current = handle;
    const subscribe = () => {
      void api
        .invoke('fleet:subscribe', { peerId, projectId, shellIndex })
        .then((result) => {
          subscriptionId = result.subscriptionId;
          if (!active) {
            detach();
            return;
          }
          resize();
          for (const event of pending) applyEvent(event);
          pending = [];
          pendingBytes = 0;
        })
        .catch(() => {
          if (active) fail('Could not attach remote terminal. Check the connection and retry.');
        });
    };
    let fontsReady = false;
    const open = () => {
      if (!active || opened || !fontsReady || host.clientWidth < 20 || host.clientHeight < 20)
        return;
      term.open(host);
      opened = true;
      resize();
      subscribe();
    };
    const observer = new ResizeObserver(() => {
      open();
      resize();
    });
    observer.observe(host);
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'data-theme',
        'data-palette',
        FROST_ATTR.platform,
        FROST_ATTR.chromeFrost,
        FROST_ATTR.terminalFrost,
      ],
    });
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
      osc52.dispose();
      term.dispose();
      if (owner?.current === handle) owner.current = null;
      if (resizeRef.current === resize) resizeRef.current = null;
      if (terminalRef.current === term) terminalRef.current = null;
    };
  }, [peerId, projectId, shellIndex, epoch]);

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

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-3">
      <div
        ref={hostRef}
        role="region"
        aria-label={label}
        className="h-full w-full min-w-0 isolate"
      />
    </div>
  );
}
