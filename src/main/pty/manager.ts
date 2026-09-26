import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { ResolvedLaunch } from '@main/domain/launch';
import { toSpawnableArgv } from '@main/domain/shell';

interface Entry {
  projectId: number; shellIndex: number;
  pty: IPty; pid: number;
  cols: number; rows: number;
  startedAt: number;
  earlyBuffer: string;   // captured output within the first 3s
  bufferOpen: boolean;
  /** Rolling scrollback used by new viewports to replay recent output on mount. */
  scrollback: string;
  /**
   * ms epoch when the user last submitted a line (input containing \r). We
   * fire the "command completed" notification only for commands that have
   * been running for more than DONE_MIN_MS — no ping for `ls`.
   */
  cmdStartedAt: number | null;
  /** ms epoch of the last pty:data event. Used to detect idle after work. */
  lastDataAt: number;
  /** Guard so the same command fires exactly one notification. */
  cmdNotified: boolean;
  /** Ports the shell announced via "listening on 3000" / "Local: http://…" etc. */
  ports: Set<number>;
}

const key = (p: number, s: number) => `${p}:${s}`;
const EARLY_BUFFER_MS = 3000;
const EARLY_BUFFER_CAP = 32 * 1024;
const SCROLLBACK_CAP = 256 * 1024;   // 256 KiB rolling
const DONE_MIN_MS  = 8_000;   // ignore commands shorter than 8s
const DONE_IDLE_MS = 1_200;   // no data for 1.2s ⇒ "command is done"
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

/** Regex bank for port-detection. Each match's group 1 is the port number. */
const PORT_PATTERNS: RegExp[] = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:](\d{2,5})\b/gi,
  /\blistening on (?:port )?(?:.*?)?(\d{2,5})\b/gi,
  /\b(?:port|Port)[:\s=]+(\d{2,5})\b/g,
  /\bserver (?:started|running|listen(?:ing)?)[^0-9]{0,32}(\d{2,5})\b/gi,
];
/** Very few processes bind < 1024 without root; ignore those to cut noise. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export class PtyManager extends EventEmitter {
  private entries = new Map<string, Entry>();
  /** Last size the viewport asked for, per shell — outlives the PTY so a spawn can honour it. */
  private requestedSizes = new Map<string, { cols: number; rows: number }>();

  async spawn(projectId: number, shellIndex: number, launch: ResolvedLaunch, cols?: number, rows?: number): Promise<{ pid: number }> {
    const k = key(projectId, shellIndex);
    if (this.entries.has(k)) throw new Error(`already spawned: ${k}`);
    const requested = this.requestedSizes.get(k);
    cols ??= requested?.cols ?? DEFAULT_COLS;
    rows ??= requested?.rows ?? DEFAULT_ROWS;
    const [command, ...args] = toSpawnableArgv(launch.argv);
    if (!command) throw new Error('empty argv');
    const pty = ptySpawn(command, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env } as { [k: string]: string },
    });
    const entry: Entry = {
      projectId, shellIndex, pty, pid: pty.pid, cols, rows,
      startedAt: Date.now(), earlyBuffer: '', bufferOpen: true,
      scrollback: '',
      cmdStartedAt: null, lastDataAt: Date.now(), cmdNotified: false,
      ports: new Set<number>(),
    };
    this.entries.set(k, entry);
    pty.onData((data: string) => {
      entry.lastDataAt = Date.now();
      // Scan for freshly-announced ports (dev servers, docker binds, etc.).
      // Reports go via the `ports` event so the renderer can update chips.
      let portDirty = false;
      for (const re of PORT_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(data)) !== null) {
          const port = Number(m[1]);
          if (port >= MIN_PORT && port <= MAX_PORT && !entry.ports.has(port)) {
            entry.ports.add(port);
            portDirty = true;
          }
        }
      }
      if (portDirty) {
        this.emit('ports', { projectId, shellIndex, ports: Array.from(entry.ports) });
      }
      if (entry.bufferOpen && entry.earlyBuffer.length < EARLY_BUFFER_CAP) {
        entry.earlyBuffer += data;
      }
      // Keep rolling scrollback so late-attaching viewports can replay. The
      // raw-slice truncation used to cut mid-escape-sequence (e.g. inside a
      // `\033[38;5;208m` colour code), and the replayed terminal then
      // interpreted the leftover fragment as garbage — that's what produced
      // the red/green splice bug on project-switch. Snap the truncation to
      // the next newline and drop any partial ESC prefix before the newline
      // so we always resume from a clean line boundary. See ShellTab's
      // snapshot flow for the replay side.
      entry.scrollback += data;
      if (entry.scrollback.length > SCROLLBACK_CAP) {
        let cut = entry.scrollback.length - SCROLLBACK_CAP;
        const nextNl = entry.scrollback.indexOf('\n', cut);
        // Only advance to the newline if it lands within a reasonable window
        // (otherwise a single very long line could hold us hostage).
        if (nextNl > -1 && nextNl - cut < 8192) cut = nextNl + 1;
        // If we still land inside an ANSI escape (long CSI without any
        // terminator letter in the next 32 bytes → almost certainly a
        // fragment), advance to the following newline to skip it entirely.
        const window = entry.scrollback.slice(cut, cut + 32);
        if (window.includes('\x1b') && !/[A-Za-z]/.test(window)) {
          const skipTo = entry.scrollback.indexOf('\n', cut);
          if (skipTo > -1 && skipTo - cut < 16384) cut = skipTo + 1;
        }
        entry.scrollback = entry.scrollback.slice(cut);
      }
      this.emit('data', { projectId, shellIndex, data });
    });
    setTimeout(() => { entry.bufferOpen = false; entry.earlyBuffer = ''; }, EARLY_BUFFER_MS);
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      const captured = entry.earlyBuffer;
      const uptimeMs = Date.now() - entry.startedAt;
      this.entries.delete(k);
      this.emit('exit', { projectId, shellIndex, code: exitCode, uptimeMs, earlyOutput: captured });
    });
    return { pid: pty.pid };
  }

  getEarlyBuffer(projectId: number, shellIndex: number): string {
    return this.entries.get(key(projectId, shellIndex))?.earlyBuffer ?? '';
  }

  /** Rolling scrollback (most recent ≤256 KiB). Empty if the shell isn't alive. */
  getScrollback(projectId: number, shellIndex: number): string {
    return this.entries.get(key(projectId, shellIndex))?.scrollback ?? '';
  }

  write(projectId: number, shellIndex: number, data: string): void {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    // `\r` (Enter) is our "new command" signal. Reset the notified flag so
    // the NEXT long-running command earns its own notification.
    if (data.includes('\r')) {
      e.cmdStartedAt = Date.now();
      e.cmdNotified = false;
    }
    e.pty.write(data);
  }

  /**
   * Called on a poll interval by the main-process caller. Returns the list of
   * shells whose command just finished (long enough to warrant a ping AND
   * idle for DONE_IDLE_MS since the last data). Marks them notified so we
   * only emit once per command. Bundled into a batch getter so the caller
   * fires a single `for` loop of OS notifications per tick.
   */
  pollDoneCommands(): Array<{ projectId: number; shellIndex: number; durationMs: number }> {
    const now = Date.now();
    const done: Array<{ projectId: number; shellIndex: number; durationMs: number }> = [];
    for (const e of this.entries.values()) {
      if (e.cmdNotified) continue;
      if (!e.cmdStartedAt) continue;
      const idle = now - e.lastDataAt;
      const duration = e.lastDataAt - e.cmdStartedAt;
      if (idle >= DONE_IDLE_MS && duration >= DONE_MIN_MS) {
        e.cmdNotified = true;
        done.push({ projectId: e.projectId, shellIndex: e.shellIndex, durationMs: duration });
      }
    }
    return done;
  }

  /**
   * Live liveness snapshot for the status-bar shells popover. Cheap: no
   * shelling out here — the caller does `ps` itself with the returned pid
   * so the sampler stays in one place.
   */
  liveShells(): Array<{ projectId: number; shellIndex: number; pid: number; startedAt: number; lastDataAt: number }> {
    return Array.from(this.entries.values()).map((e) => ({
      projectId: e.projectId,
      shellIndex: e.shellIndex,
      pid: e.pid,
      startedAt: e.startedAt,
      lastDataAt: e.lastDataAt,
    }));
  }

  /**
   * Grep every live shell's rolling scrollback for `query`. Returns matching
   * lines with a small context window. ANSI escape sequences are stripped
   * before matching so `\x1b[31m error \x1b[0m` still hits on `error`. Case
   * insensitive by default; `regex: true` runs the query as a pattern.
   */
  searchScrollback(query: string, opts: { caseSensitive?: boolean; regex?: boolean; contextLines?: number; maxPerShell?: number } = {}): Array<{
    projectId: number; shellIndex: number; pid: number;
    line: string; lineNumber: number; contextBefore: string[]; contextAfter: string[];
  }> {
    if (!query) return [];
    const flags = opts.caseSensitive ? 'g' : 'gi';
    let re: RegExp;
    try {
      re = opts.regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch { return []; }
    const contextLines = Math.max(0, Math.min(5, opts.contextLines ?? 1));
    const maxPerShell = Math.max(1, opts.maxPerShell ?? 40);
    const out: Array<{ projectId: number; shellIndex: number; pid: number; line: string; lineNumber: number; contextBefore: string[]; contextAfter: string[] }> = [];
    // Strip ANSI CSI/OSC sequences so styling doesn't hide the token.
    const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
    for (const e of this.entries.values()) {
      const lines = e.scrollback.replace(ANSI, '').split('\n');
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        out.push({
          projectId: e.projectId,
          shellIndex: e.shellIndex,
          pid: e.pid,
          line,
          lineNumber: i + 1,
          contextBefore: lines.slice(Math.max(0, i - contextLines), i),
          contextAfter:  lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)),
        });
        hits++;
        if (hits >= maxPerShell) break;
      }
    }
    return out;
  }

  /** Snapshot of every shell's currently-known ports (used on renderer mount). */
  allPorts(): Array<{ projectId: number; shellIndex: number; ports: number[] }> {
    const out: Array<{ projectId: number; shellIndex: number; ports: number[] }> = [];
    for (const e of this.entries.values()) {
      if (e.ports.size > 0) out.push({ projectId: e.projectId, shellIndex: e.shellIndex, ports: Array.from(e.ports) });
    }
    return out;
  }

  resize(projectId: number, shellIndex: number, cols: number, rows: number): void {
    this.requestedSizes.set(key(projectId, shellIndex), { cols, rows });
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.resize(cols, rows);
    e.cols = cols; e.rows = rows;
  }

  async kill(projectId: number, shellIndex: number): Promise<void> {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.kill();
    this.entries.delete(key(projectId, shellIndex));
  }

  isAlive(projectId: number, shellIndex: number): boolean {
    return this.entries.has(key(projectId, shellIndex));
  }

  list(): Array<{ projectId: number; shellIndex: number; pid: number; cols: number; rows: number; startedAt: number }> {
    return [...this.entries.values()].map(e => ({
      projectId: e.projectId, shellIndex: e.shellIndex, pid: e.pid, cols: e.cols, rows: e.rows, startedAt: e.startedAt,
    }));
  }
}
