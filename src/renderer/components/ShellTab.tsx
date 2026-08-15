import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedNumber } from '@renderer/hooks/usePersistedNumber';
import { Terminal, type IDisposable, type ITheme, type ILinkProvider, type IBufferCellPosition } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { useShellStream } from '@renderer/hooks/useShellStream';
import { detectPaths } from '@shared/detect-paths';
import { HoverPreview, type HoverPreviewState } from './HoverPreview';

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function buildTheme(): ITheme {
  return {
    background: 'rgba(0,0,0,0)',
    foreground: readVar('--term-fg',        '#e6edf3'),
    cursor:     readVar('--term-cursor',    '#e6edf3'),
    selectionBackground: readVar('--term-selection', 'rgba(255,255,255,0.2)'),
  };
}

export function ShellTab({
  projectId, shellIndex, onOpenFile,
}: {
  projectId: number;
  shellIndex: number;
  onOpenFile?: (relPath: string, line: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Ordering guard for the "snapshot vs live" race on remount. Live PTY
  // data can arrive between term.open() and the snapshot HTTP round-trip
  // resolving; if we wrote it straight to xterm and then also wrote the
  // snapshot, we'd get a splice like [live delta][full scrollback again].
  // Instead we buffer live in `pendingLive` until the snapshot lands,
  // then flush the buffer. `snapshotReady` flips to true after either
  // path completes so live writes go direct from then on.
  const snapshotReady = useRef(false);
  const pendingLive = useRef('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fontSize, setFontSize] = usePersistedNumber('metaide.shellFontSize', 14, 9, 28);
  const [hover, setHover] = useState<HoverPreviewState | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const onOpenFileRef = useRef<typeof onOpenFile>(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  useEffect(() => {
    if (!termHostRef.current) return;
    const term = new Terminal({
      scrollback: 10000,
      // Explicit SF Mono stack — first match wins. Falls back through
      // common developer monospace fonts. `ui-monospace` alone can pick
      // Menlo bitmap fallback on some setups and looks pixelated.
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
      fontSize,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: buildTheme(),
      allowProposedApi: true,
      screenReaderMode: true,
      // Explicit — don't let xterm try to boost contrast (blurs rendering).
      minimumContrastRatio: 1,
      // Skip WebGL: on macOS with translucent backgrounds and retina it
      // sometimes rasterises to a half-DPR buffer and looks pixelated.
      // The canvas renderer (default) is subpixel-crisp here.
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_ev: MouseEvent, url: string) => {
      void api.invoke('app:open-external', { url }).catch((e) => console.error(e));
    }));
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;

    // File-path link provider: matches things like src/main/index.ts:42
    // in terminal output, shows a hover preview, click opens in Files.
    const pathLinkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber, callback) {
        const buf = term.buffer.active;
        const rawLine = buf.getLine(bufferLineNumber - 1);
        if (!rawLine) { callback(undefined); return; }
        const text = rawLine.translateToString(true);
        const hits = detectPaths(text);
        if (hits.length === 0) { callback(undefined); return; }
        callback(hits.map((h) => ({
          range: {
            start: { x: h.startIndex + 1, y: bufferLineNumber } as IBufferCellPosition,
            end:   { x: h.endIndex,       y: bufferLineNumber } as IBufferCellPosition,
          },
          text: h.raw,
          activate: () => {
            setHover(null);
            onOpenFileRef.current?.(h.path, h.line);
          },
          hover: (ev: MouseEvent) => {
            setHover({ x: ev.clientX, y: ev.clientY, projectId, path: h.path, line: h.line });
          },
          leave: () => { setHover(null); },
        })));
      },
    };
    const linkProviderDisposable: IDisposable = term.registerLinkProvider(pathLinkProvider);

    term.open(termHostRef.current);
    term.onData((data) => { void api.invoke('shells:write', { projectId, shellIndex, data }); });
    termRef.current = term;

    // Track the last-fit rows/cols so we can drop no-op resize calls that
    // would otherwise spam the PTY when the container reports the same
    // size repeatedly.
    let lastCols = -1, lastRows = -1;
    function syncSize() {
      try {
        // Skip when the host element hasn't been laid out yet — trying to
        // fit against a 0×0 element writes a bogus 0-col grid, which then
        // renders no text even when data arrives later.
        const host = termHostRef.current;
        if (!host || host.clientWidth < 20 || host.clientHeight < 20) return;
        fit.fit();
        if (term.cols === lastCols && term.rows === lastRows) return;
        lastCols = term.cols; lastRows = term.rows;
        void api.invoke('shells:resize', { projectId, shellIndex, cols: term.cols, rows: term.rows });
      } catch { /* container might be zero-sized during transitions */ }
    }

    // Fit staircase: two rAFs (fonts + layout), then follow-ups at 100/300ms
    // to catch the case where the flex parent hadn't settled on the first
    // fit — that's the "have to resize the window to refresh" bug. On top of
    // this the ResizeObserver keeps things sized during genuine changes.
    requestAnimationFrame(() => requestAnimationFrame(syncSize));
    const late1 = window.setTimeout(syncSize, 100);
    const late2 = window.setTimeout(syncSize, 300);
    // Also whenever this window regains focus, force a refit — Chromium can
    // pause layout while backgrounded and re-emerge with a wrong grid.
    const onWinFocus = () => syncSize();
    window.addEventListener('focus', onWinFocus);

    // Replay any existing scrollback from the PTY so late-attaching viewports
    // (a pop-out window, tab switch back, second monitor) don't see an empty
    // terminal while the shell is idle. Live data that arrives DURING the
    // snapshot fetch is buffered and flushed after — see `snapshotReady`.
    snapshotReady.current = false;
    pendingLive.current = '';
    (async () => {
      try {
        const { output } = await api.invoke('shells:snapshot', { projectId, shellIndex });
        if (termRef.current !== term) return; // component unmounted / re-mounted
        if (output) {
          // Full terminal reset before replay — a bare SGR reset (\x1b[0m)
          // isn't enough because scrollback can contain unbalanced sequences
          // like alt-screen enter (\x1b[?1049h from vim/less) or cursor-
          // hidden mode, which the new terminal inherits and then renders
          // garbage. term.reset() is xterm's RIS equivalent: attrs, cursor,
          // wrap, alt-screen — all back to initial.
          term.reset();
          // Also strip any partial ANSI escape at the very start of the
          // scrollback. The main-side truncation already snaps to newlines,
          // but a mid-CSI cut on a very long line can still slip through.
          // Drop everything up to (and including) the first newline if the
          // buffer opens with an ESC that has no `m` / `H` terminator in
          // the first 32 chars — that's almost certainly a fragment.
          let safe = output;
          if (safe.startsWith('\x1b') && !/[A-Za-z]/.test(safe.slice(1, 32))) {
            const nl = safe.indexOf('\n');
            if (nl > -1 && nl < 2048) safe = safe.slice(nl + 1);
          }
          term.write(safe);
          // Trailing SGR reset defends the live stream that plays after.
          term.write('\x1b[0m');
        }
        if (pendingLive.current) term.write(pendingLive.current);
      } catch { /* ignore — snapshot is best-effort */ }
      finally {
        snapshotReady.current = true;
        pendingLive.current = '';
        // Snapshot replay lands after mount → re-fit + refresh so the
        // terminal repaints against whatever the container's ACTUAL size
        // ended up being (rather than whatever it was during the double-
        // rAF at mount).
        requestAnimationFrame(() => {
          syncSize();
          try { term.refresh(0, Math.max(0, term.rows - 1)); } catch { /* fine */ }
        });
      }
    })();

    const ro = new ResizeObserver(syncSize);
    if (containerRef.current) ro.observe(containerRef.current);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => { term.options.theme = buildTheme(); };
    media.addEventListener('change', onScheme);

    return () => {
      window.clearTimeout(late1);
      window.clearTimeout(late2);
      window.removeEventListener('focus', onWinFocus);
      ro.disconnect();
      media.removeEventListener('change', onScheme);
      linkProviderDisposable.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
    // We deliberately don't include fontSize here — a font-size change
    // shouldn't recreate the terminal. The separate effect below applies
    // it to the running Terminal instance instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, shellIndex]);

  const findNext = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findNext(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);
  const findPrev = useCallback((q: string) => {
    if (!q || !searchRef.current) return;
    searchRef.current.findPrevious(q, { caseSensitive: false, wholeWord: false, regex: false });
  }, []);

  // Push font-size changes into the running Terminal instance so ⌘+/⌘- feels live.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    // Trigger a resize so the fit addon recomputes cols/rows for the new font metrics.
    try {
      const el = containerRef.current;
      if (el) {
        const evt = new Event('resize'); void evt; // no-op; ResizeObserver already handles container size, but font metric change requires fit re-run
      }
    } catch { /* ignore */ }
  }, [fontSize]);

  // ⌘F opens the terminal search overlay when this tab has focus.
  // ⌘= / ⌘- / ⌘0 zoom the terminal font.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setFontSize(fontSize + 1);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        setFontSize(fontSize - 1);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        setFontSize(14);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [fontSize, setFontSize]);

  useShellStream(
    projectId,
    shellIndex,
    (data) => {
      if (snapshotReady.current) termRef.current?.write(data);
      else pendingLive.current += data;
    },
    () => { termRef.current?.write('\r\n[shell exited]\r\n'); },
  );

  // Outer div = padding + background. Inner div = pure terminal viewport,
  // so xterm's own geometry math sees an element with no padding or extra chrome.
  return (
    <div
      ref={containerRef}
      data-testid="shell-tab"
      tabIndex={-1}
      onDragOver={(e) => {
        // Terminal accepts BOTH OS file drops (from Finder) AND intra-app
        // drags from the Files tree (which set text/plain to the relPath).
        // Without preventDefault the webview would try to navigate to
        // file://<dropped-path> — that's the "error" the user was seeing.
        const types = e.dataTransfer?.types;
        if (types?.includes('Files') || types?.includes('text/plain')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        setDropActive(false);
        const dt = e.dataTransfer;
        if (!dt) return;
        let paths: string[] = [];
        if (dt.files?.length) {
          paths = Array.from(dt.files).map((f) => api.pathForFile(f)).filter((p) => !!p);
        }
        if (paths.length === 0) {
          const text = dt.getData('text/plain');
          if (text) paths = [text];
        }
        if (paths.length === 0) return;
        e.preventDefault();
        // Single-quote each path so the CLI receives it verbatim, and escape
        // any embedded single-quote via the standard `'"'"'` gymnastics.
        const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
        void api.invoke('shells:write', { projectId, shellIndex, data: quoted });
      }}
      className="relative w-full h-full px-3 pt-2 pb-3 bg-transparent focus:outline-none"
    >
      <div ref={termHostRef} className="w-full h-full" />
      {dropActive && (
        <div className="absolute inset-2 pointer-events-none rounded-md border-2 border-dashed border-[color:var(--accent)] bg-[color:var(--accent)]/10 flex items-center justify-center text-xs text-[--text] font-medium">
          Drop to paste path
        </div>
      )}
      {searchOpen && (
        <div
          className="absolute top-2 right-3 z-10 flex items-center gap-1 bg-[--panel-strong] border border-[--border] rounded-md shadow-lg px-1.5 py-1"
          data-testid="shell-search"
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter')      { if (e.shiftKey) findPrev(searchQuery); else findNext(searchQuery); }
              else if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); searchRef.current?.clearDecorations(); termRef.current?.focus(); }
            }}
            placeholder="Find…"
            className="bg-transparent text-sm px-2 py-0.5 outline-none placeholder:text-[--text-muted] w-40"
          />
          <button onClick={() => findPrev(searchQuery)} title="Previous (⇧↩)" className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↑</button>
          <button onClick={() => findNext(searchQuery)} title="Next (↩)"      className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]">↓</button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(''); searchRef.current?.clearDecorations(); termRef.current?.focus(); }}
            title="Close (Esc)"
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
          >
            ✕
          </button>
        </div>
      )}
      <HoverPreview
        state={hover}
        onOpen={(relPath, line) => { setHover(null); onOpenFileRef.current?.(relPath, line); }}
      />
    </div>
  );
}
