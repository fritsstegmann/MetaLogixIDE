/**
 * Real git repositories for the Diff tab E2E suite (docs/plan/2026-10-02-diff-tab.md §9).
 *
 * `launch()` in claude-harness.ts gives every project an EMPTY `.git` folder
 * (no `git init`), which git rejects. `seedRepo` replaces it with a real
 * repository: `git init -b main`, a baseline commit, then each scenario's
 * mutation. Call it after `launch()` and before the project is opened.
 *
 * Every git call here runs with `GIT_CONFIG_GLOBAL=/dev/null` and
 * `GIT_CONFIG_NOSYSTEM=1`, and sets the commit identity through `-c`, so the
 * developer's own git config can neither break nor colour the fixture.
 *
 * Every seeded-state assumption is asserted at seed time (`assertSeeded`):
 * the porcelain status must hold exactly the scenarios' entries, and each
 * scenario checks the facts its tests rely on (hunk starts, file sizes,
 * modes, unreadability, that repo-configured programs really do fire on a
 * plain git call). A wrong assumption fails here, naming its cause, instead
 * of surfacing later as a confusing UI assertion.
 */
import { execFileSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
};

const IDENTITY = ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false'];

/** Runs git in `dir`; throws with git's stderr when it exits non-zero (unless `okStatus` lists the code). */
export function git(dir: string, args: string[], okStatus: number[] = [0]): string {
  try {
    return execFileSync('git', [...IDENTITY, ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    if (err.status !== undefined && okStatus.includes(err.status)) return err.stdout ?? '';
    throw new Error(`git ${args.join(' ')} failed in ${dir} (exit ${String(err.status)}): ${err.stderr ?? String(e)}`);
  }
}

export interface PorcelainEntry { xy: string; path: string; orig?: string }

/** `git status --porcelain=v1 -z --untracked-files=all`, parsed. A rename/copy record is `XY NEW\0ORIG\0`. */
export function porcelain(dir: string): PorcelainEntry[] {
  const out = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter((p) => p.length > 0);
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') entries.push({ xy, path, orig: parts[++i] });
    else entries.push({ xy, path });
  }
  return entries;
}

/** Porcelain entries with a staged change (index column set; untracked `??` excluded). */
export function stagedEntries(dir: string): PorcelainEntry[] {
  return porcelain(dir).filter((e) => e.xy[0] !== ' ' && e.xy[0] !== '?');
}

/** Stages everything and commits it, so the working tree is clean. */
export function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function write(dir: string, rel: string, content: string | Buffer): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8');
}

function replaceIn(dir: string, rel: string, from: string, to: string): void {
  const text = read(dir, rel);
  if (!text.includes(from)) throw new Error(`seed: ${rel} does not contain ${JSON.stringify(from)}`);
  writeFileSync(join(dir, rel), text.replace(from, to));
}

function seedFail(scenario: string, cause: string): never {
  throw new Error(`git-repo seed self-check failed [${scenario}]: ${cause}`);
}

/* ─────────────────────────────── content builders ─────────────────────────────── */

/** `long.ts` line i (1-based). */
export const longLine = (i: number): string => `export const v${i} = ${i};`;
/** Lines inserted after old line 10, so every later new line number is old + 4. */
export const LONG_INSERTED = [1, 2, 3, 4].map((k) => `export const ins${k} = ${k};`);
export const LONG_EDITED_123 = 'export const v123 = 9123;';
export const LONG_MERGED = 'export const merged = 180181182;';

function longBaseline(): string {
  return Array.from({ length: 200 }, (_, i) => longLine(i + 1)).join('\n') + '\n';
}

/** Old lines 1–200 with: 4 lines inserted after line 10, line 123 edited, lines 180–182 replaced by one. */
function longModified(): string {
  const out: string[] = [];
  for (let i = 1; i <= 200; i++) {
    if (i === 123) out.push(LONG_EDITED_123);
    else if (i === 180) out.push(LONG_MERGED);
    else if (i === 181 || i === 182) continue;
    else out.push(longLine(i));
    if (i === 10) out.push(...LONG_INSERTED);
  }
  return out.join('\n') + '\n';
}

/** `comment.ts`: a block comment from line 2 to line 22; line 12 sits inside it. */
function commentBaseline(): string {
  const lines = ['export const before = 1;', '/*'];
  for (let n = 3; n <= 21; n++) lines.push(` * comment line ${n}`);
  lines.push(' */', 'export const after = 2;');
  return lines.join('\n') + '\n';
}

export const RENAME_OLD = 'old.ts';
export const RENAME_NEW = 'new name é.js';
const RENAME_BASE = [
  'export const one = 1;',
  'export const two = 2;',
  'export const three = 3;',
  'export const four = 4;',
  'export const five = 5;',
  'export interface Shape { size: number }',
  'export const six = 6;',
].join('\n') + '\n';

export const XSS_IMG = '<img src=x onerror="window.__xss=1">';
export const XSS_SCRIPT = '</span><script>window.__xss=2</script>';

/** ~`bytes` of TypeScript; line `mark` is the one the mutation edits. */
function bulkTs(prefix: string, bytes: number): { text: string; mark: string } {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `export const ${prefix}${i} = ${i};`;
    lines.push(line);
    size += line.length + 1;
  }
  while (size > bytes) size -= lines.pop()!.length + 1;
  const mark = lines[Math.floor(lines.length / 2)]!;
  return { text: lines.join('\n') + '\n', mark };
}

export const LONG_PATH =
  'dir/deeply/nested/folder/with/a/very/long/name/that/does/not/fit/in/the/row/really-long-file-name-for-truncation.txt';
export const MANY_PATHS = Array.from({ length: 60 }, (_, i) => `many/f${String(i).padStart(2, '0')}.txt`);

export const HIGHLIGHT_MAX_BYTES = 256 * 1024;
export const HALF_EDIT = 'export const halfEdited = 424242;';
export const MID_EDIT = 'export const midEdited = 434343;';
export const LINK_SECRET = 'OUTSIDE-SECRET-CONTENT-7f3a';

/* ─────────────────────────────── scenarios ─────────────────────────────── */

export interface SeedContext {
  dir: string;
  /** A folder outside the project, for symlink targets. */
  outside: string;
}

interface Scenario {
  /** Files written before the baseline commit. */
  baseline?: (c: SeedContext) => void;
  /** Changes applied after the baseline commit. */
  mutate?: (c: SeedContext) => void;
  /** The exact porcelain entries this scenario produces. */
  expect: PorcelainEntry[];
  /** Further seeded-state facts, checked after every scenario has been applied. */
  check?: (c: SeedContext) => void;
}

export const SCENARIOS = {
  /** a.ts: a staged edit (AC14, AC34 staged). */
  aTs: {
    baseline: ({ dir }) => write(dir, 'a.ts', 'export function alpha(): number {\n  const base = 1;\n  return base;\n}\n'),
    mutate: ({ dir }) => { replaceIn(dir, 'a.ts', 'const base = 1;', 'const base = 2;'); git(dir, ['add', 'a.ts']); },
    expect: [{ xy: 'M ', path: 'a.ts' }],
  },
  /** b.ts: staged, then edited again, so it is listed twice (AC9, AC34). */
  bTs: {
    baseline: ({ dir }) => write(dir, 'b.ts', "export const b = 'one';\n"),
    mutate: ({ dir }) => {
      write(dir, 'b.ts', "export const b = 'two';\n");
      git(dir, ['add', 'b.ts']);
      write(dir, 'b.ts', "export const b = 'three';\n");
    },
    expect: [{ xy: 'MM', path: 'b.ts' }],
  },
  /** long.ts: three hunks; the second starts at old 120 / new 124; the third is a 3-for-1 replacement (AC14, AC35, AC36). */
  long: {
    baseline: ({ dir }) => write(dir, 'long.ts', longBaseline()),
    mutate: ({ dir }) => write(dir, 'long.ts', longModified()),
    expect: [{ xy: ' M', path: 'long.ts' }],
    check: ({ dir }) => {
      const d = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--', 'long.ts']);
      const starts = [...d.matchAll(/^@@ -(\d+),\d+ \+(\d+),\d+ @@/gm)].map((m) => `${m[1]}/${m[2]}`);
      if (starts.length !== 3) seedFail('long', `expected 3 hunks, git printed ${starts.length}: ${starts.join(' ')}`);
      if (starts[0] !== '8/8') seedFail('long', `first hunk must start at old 8 / new 8 (after line 1), got ${starts[0]}`);
      if (starts[1] !== '120/124') seedFail('long', `second hunk must start at old 120 / new 124, got ${starts[1]}`);
      if (!/^-export const v180 = 180;\n-export const v181 = 181;\n-export const v182 = 182;\n\+export const merged/m.test(d)) {
        seedFail('long', 'third hunk is not a 3-removed / 1-added block');
      }
    },
  },
  /** comment.ts: the changed line sits inside a block comment opened 10 lines above it (AC38). */
  comment: {
    baseline: ({ dir }) => write(dir, 'comment.ts', commentBaseline()),
    mutate: ({ dir }) => replaceIn(dir, 'comment.ts', ' * comment line 12\n', ' * comment line 12 changed\n'),
    expect: [{ xy: ' M', path: 'comment.ts' }],
    check: ({ dir }) => {
      const d = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--', 'comment.ts']);
      if (d.includes('/*')) seedFail('comment', 'the hunk must not contain the comment opener, or AC38 is not exercised');
      if (!/^@@ -9,7 \+9,7 @@/m.test(d)) seedFail('comment', 'expected a single hunk at line 9');
    },
  },
  /** old.ts renamed (and edited) to "new name é.js", staged: a rename across languages with a space and a non-ASCII name (AC19, AC37, AC33). */
  rename: {
    baseline: ({ dir }) => write(dir, RENAME_OLD, RENAME_BASE),
    mutate: ({ dir }) => {
      git(dir, ['mv', RENAME_OLD, RENAME_NEW]);
      replaceIn(dir, RENAME_NEW, 'export const six = 6;', 'export const six = 66;');
      git(dir, ['add', RENAME_NEW]);
    },
    expect: [{ xy: 'R ', path: RENAME_NEW, orig: RENAME_OLD }],
    check: ({ dir }) => {
      const d = git(dir, ['diff', '--cached', '-M', '--no-ext-diff', '--no-textconv', '--', RENAME_OLD, RENAME_NEW]);
      if (!d.includes(`rename from ${RENAME_OLD}`)) seedFail('rename', `git does not see a rename: ${d.slice(0, 300)}`);
      if (!d.includes(' export interface Shape { size: number }')) seedFail('rename', 'the interface line must be a context line of the hunk');
    },
  },
  /** Two untracked files in nested folders, listed one by one (AC10, AC34 untracked). */
  untracked: {
    mutate: ({ dir }) => {
      write(dir, 'dir/sub/u1.txt', 'untracked one\nuntracked two\n');
      write(dir, 'dir/u2.txt', 'second untracked\n');
    },
    expect: [{ xy: '??', path: 'dir/sub/u1.txt' }, { xy: '??', path: 'dir/u2.txt' }],
  },
  /** An untracked file whose path is far wider than the list (AC11). */
  longPath: {
    mutate: ({ dir }) => write(dir, LONG_PATH, 'deep\n'),
    expect: [{ xy: '??', path: LONG_PATH }],
  },
  /** 60 untracked files, so the file list overflows and scrolls on its own (AC16). */
  many: {
    mutate: ({ dir }) => { for (const p of MANY_PATHS) write(dir, p, `${p}\n`); },
    expect: MANY_PATHS.map((path) => ({ xy: '??', path })),
  },
  /** gone.ts: staged deletion (AC34 deleted). */
  gone: {
    baseline: ({ dir }) => write(dir, 'gone.ts', 'export const g1 = 1;\nexport const g2 = 2;\nexport const g3 = 3;\n'),
    mutate: ({ dir }) => git(dir, ['rm', '-q', 'gone.ts']),
    expect: [{ xy: 'D ', path: 'gone.ts' }],
  },
  /** added.ts: a staged new file with no HEAD version (AC34 staged added). */
  added: {
    mutate: ({ dir }) => { write(dir, 'added.ts', 'export const fresh1 = 1;\nexport const fresh2 = 2;\n'); git(dir, ['add', 'added.ts']); },
    expect: [{ xy: 'A ', path: 'added.ts' }],
  },
  /** img.bin: modified binary content (AC18 binary). */
  binary: {
    baseline: ({ dir }) => write(dir, 'img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0x03])),
    mutate: ({ dir }) => write(dir, 'img.bin', Buffer.from([0x89, 0x50, 0x00, 0x09, 0x08, 0x00, 0x07, 0x00])),
    expect: [{ xy: ' M', path: 'img.bin' }],
    check: ({ dir }) => {
      const d = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--', 'img.bin']);
      if (!/^Binary files .* differ$/m.test(d)) seedFail('binary', `git does not treat img.bin as binary: ${d}`);
    },
  },
  /** run.sh: a mode-only change 100644 → 100755 (AC18 mode). */
  mode: {
    baseline: ({ dir }) => { write(dir, 'run.sh', '#!/bin/sh\necho hi\n'); chmodSync(join(dir, 'run.sh'), 0o644); },
    mutate: ({ dir }) => chmodSync(join(dir, 'run.sh'), 0o755),
    expect: [{ xy: ' M', path: 'run.sh' }],
    check: ({ dir }) => {
      const d = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--', 'run.sh']);
      if (!d.includes('old mode 100644') || !d.includes('new mode 100755') || d.includes('@@')) {
        seedFail('mode', `expected a mode-only diff (is core.fileMode off?): ${d}`);
      }
    },
  },
  /** xss.html: changed lines that look like HTML/script; xss.unknownext: the same payload untracked and unhighlighted (AC40). */
  xss: {
    baseline: ({ dir }) => write(dir, 'xss.html', '<!doctype html>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n'),
    mutate: ({ dir }) => {
      replaceIn(dir, 'xss.html', '<p>two</p>\n', `${XSS_IMG}\n${XSS_SCRIPT}\n`);
      write(dir, 'xss.unknownext', `${XSS_IMG}\n${XSS_SCRIPT}\n`);
    },
    expect: [{ xy: ' M', path: 'xss.html' }, { xy: '??', path: 'xss.unknownext' }],
  },
  /** wide.ts: a 400-character changed line (AC16 horizontal scroll). */
  wide: {
    baseline: ({ dir }) => write(dir, 'wide.ts', `export const wide = '${'w'.repeat(400)}';\nexport const tail = 1;\n`),
    mutate: ({ dir }) => replaceIn(dir, 'wide.ts', 'w'.repeat(400), 'x'.repeat(400)),
    expect: [{ xy: ' M', path: 'wide.ts' }],
  },
  /** half.ts: ~250 KiB per side, under the 256 KiB cap, so it is highlighted; used for the P2 timing (AC42). */
  half: {
    baseline: (c) => { const b = bulkTs('h', 250 * 1024); write(c.dir, 'half.ts', b.text); halfMark.set(c.dir, b.mark); },
    mutate: (c) => replaceIn(c.dir, 'half.ts', `${halfMark.get(c.dir)!}\n`, `${HALF_EDIT}\n`),
    expect: [{ xy: ' M', path: 'half.ts' }],
    check: ({ dir }) => {
      const head = git(dir, ['cat-file', '-s', 'HEAD:half.ts']).trim();
      const work = statSync(join(dir, 'half.ts')).size;
      for (const [side, n] of [['HEAD', Number(head)], ['worktree', work]] as const) {
        if (n > HIGHLIGHT_MAX_BYTES || n < 240 * 1024) seedFail('half', `${side} side is ${n} bytes; must be ~250 KiB and <= 256 KiB`);
      }
    },
  },
  /** mid.ts: ~600 KiB per side, over the 256 KiB cap, with a small edit (AC42). */
  mid: {
    baseline: (c) => { const b = bulkTs('m', 600 * 1024); write(c.dir, 'mid.ts', b.text); midMark.set(c.dir, b.mark); },
    mutate: (c) => replaceIn(c.dir, 'mid.ts', `${midMark.get(c.dir)!}\n`, `${MID_EDIT}\n`),
    expect: [{ xy: ' M', path: 'mid.ts' }],
    check: ({ dir }) => {
      const head = Number(git(dir, ['cat-file', '-s', 'HEAD:mid.ts']).trim());
      const work = statSync(join(dir, 'mid.ts')).size;
      if (head <= HIGHLIGHT_MAX_BYTES || work <= HIGHLIGHT_MAX_BYTES) seedFail('mid', `both sides must exceed 256 KiB (HEAD ${head}, worktree ${work})`);
      const d = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--', 'mid.ts']);
      if (d.length > 4096) seedFail('mid', `the diff must be small, got ${d.length} bytes`);
    },
  },
  /** big.txt: untracked, 1.2 MB, so its diff exceeds the 1 MiB cap (AC20, AC41). */
  big: {
    mutate: ({ dir }) => write(dir, 'big.txt', `${'y'.repeat(99)}\n`.repeat(12_000)),
    expect: [{ xy: '??', path: 'big.txt' }],
    check: ({ dir }) => {
      if (statSync(join(dir, 'big.txt')).size <= 1024 * 1024) seedFail('big', 'big.txt must exceed 1 MiB');
    },
  },
  /** link: an untracked symlink to a file outside the project (AC43). */
  link: {
    mutate: ({ dir, outside }) => {
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), `${LINK_SECRET}\n`);
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'link'));
    },
    expect: [{ xy: '??', path: 'link' }],
    check: ({ dir }) => {
      if (!lstatSync(join(dir, 'link')).isSymbolicLink()) seedFail('link', 'link is not a symlink');
    },
  },
  /** noperm.txt: untracked and unreadable, so its diff fails (AC17). */
  noperm: {
    mutate: ({ dir }) => { write(dir, 'noperm.txt', 'cannot read me\n'); chmodSync(join(dir, 'noperm.txt'), 0o000); },
    expect: [{ xy: '??', path: 'noperm.txt' }],
    check: ({ dir }) => {
      let readable = true;
      try { accessSync(join(dir, 'noperm.txt'), constants.R_OK); } catch { readable = false; }
      if (readable) seedFail('noperm', 'noperm.txt is still readable (running as root?), so AC17 cannot be exercised');
    },
  },
  /** x.unknownext: an unknown extension, no newline at end of file on either side (AC36, AC37). */
  unknownExt: {
    baseline: ({ dir }) => write(dir, 'x.unknownext', 'alpha\nbeta\ngamma'),
    mutate: ({ dir }) => write(dir, 'x.unknownext', 'alpha\nbeta\ndelta'),
    expect: [{ xy: ' M', path: 'x.unknownext' }],
    check: ({ dir }) => {
      const d = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--', 'x.unknownext']);
      if (!d.includes('\\ No newline at end of file')) seedFail('unknownExt', 'git must print the no-newline marker');
    },
  },
  /** Dockerfile: not in the Files tab's highlight.js set, so plain (AC37). */
  dockerfile: {
    baseline: ({ dir }) => write(dir, 'Dockerfile', 'FROM node:20\nRUN echo one\n'),
    mutate: ({ dir }) => replaceIn(dir, 'Dockerfile', 'echo one', 'echo two'),
    expect: [{ xy: ' M', path: 'Dockerfile' }],
  },
} satisfies Record<string, Scenario>;

const halfMark = new Map<string, string>();
const midMark = new Map<string, string>();

export type ScenarioName = keyof typeof SCENARIOS;

/** Turns a harness project folder into a real repository holding the named scenarios. Returns the porcelain entries. */
export function seedRepo(c: SeedContext, names: ScenarioName[]): PorcelainEntry[] {
  initRepo(c.dir);
  const scenarios: Array<[string, Scenario]> = names.map((n) => [n, SCENARIOS[n]]);
  // A tracked file that never changes, so the baseline commit is never empty.
  write(c.dir, 'README.md', '# fixture\n');
  for (const [, s] of scenarios) s.baseline?.(c);
  commitAll(c.dir, 'baseline');
  for (const [, s] of scenarios) s.mutate?.(c);
  return assertSeeded(c, scenarios);
}

/** `rm -rf .git` (the harness's empty folder) and `git init -b main`. */
export function initRepo(dir: string): void {
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  git(dir, ['init', '-q', '-b', 'main']);
}

function assertSeeded(c: SeedContext, scenarios: Array<[string, Scenario]>): PorcelainEntry[] {
  const actual = porcelain(c.dir);
  const key = (e: PorcelainEntry) => `${e.xy}|${e.path}|${e.orig ?? ''}`;
  const want = scenarios.flatMap(([name, s]) => s.expect.map((e) => ({ name, e })));
  const have = new Set(actual.map(key));
  for (const { name, e } of want) {
    if (!have.has(key(e))) seedFail(name, `porcelain lacks ${JSON.stringify(e)}; git printed ${JSON.stringify(actual)}`);
  }
  if (actual.length !== want.length) {
    seedFail('all', `porcelain has ${actual.length} entries, scenarios expect ${want.length}: ${JSON.stringify(actual)}`);
  }
  for (const [, s] of scenarios) s.check?.(c);
  return actual;
}

/** The number of unique changed paths, which is what the tab label and the activity bar badge count (AC25). */
export function uniquePathCount(entries: PorcelainEntry[]): number {
  return new Set(entries.map((e) => e.path)).size;
}

/* ─────────────────────────────── merge conflict (AC9) ─────────────────────────────── */

/** conflict.txt in `UU` state: both branches changed the same line and the merge stopped. */
export function seedConflictRepo(dir: string): PorcelainEntry[] {
  initRepo(dir);
  write(dir, 'conflict.txt', 'base line\n');
  commitAll(dir, 'baseline');
  git(dir, ['checkout', '-q', '-b', 'other']);
  write(dir, 'conflict.txt', 'other line\n');
  commitAll(dir, 'other');
  git(dir, ['checkout', '-q', 'main']);
  write(dir, 'conflict.txt', 'main line\n');
  commitAll(dir, 'main');
  git(dir, ['merge', '-q', 'other'], [1]);
  const actual = porcelain(dir);
  if (actual.length !== 1 || actual[0]!.xy !== 'UU' || actual[0]!.path !== 'conflict.txt') {
    seedFail('conflict', `expected exactly UU conflict.txt, got ${JSON.stringify(actual)}`);
  }
  return actual;
}

/* ─────────────────────────────── repo-configured programs (AC32, AC43) ─────────────────────────────── */

export interface ProgramMarkers {
  /** One log per program; each line records the git command line that ran it. */
  fsmonitor: string;
  external: string;
  textconv: string;
}

export const TEXTCONV_OUTPUT = 'TEXTCONV-RAN-9c1e';

/**
 * A repository whose own config names three programs: `core.fsmonitor`,
 * `diff.external`, and a textconv driver for `*.tc`. Each program appends the
 * command lines of its parent and grandparent (git, possibly via `sh -c`) to
 * its log, so a test can tell which git call ran it.
 *
 * Positive control, at seed time: a plain `git status`, a plain `git diff`
 * and `git diff --no-ext-diff` must each fire their program. If they do not,
 * an empty log in the test would prove nothing, so the seed fails. The logs
 * are then truncated, so the test starts from empty logs.
 */
export function seedRepoProgramsRepo(dir: string, scriptsDir: string): ProgramMarkers {
  initRepo(dir);
  mkdirSync(scriptsDir, { recursive: true });
  const markers: ProgramMarkers = {
    fsmonitor: join(scriptsDir, 'fsmonitor.log'),
    external: join(scriptsDir, 'external.log'),
    textconv: join(scriptsDir, 'textconv.log'),
  };
  const callers = (log: string) =>
    `{ ps -o args= -p $PPID; ps -o args= -p "$(ps -o ppid= -p $PPID | tr -d ' ')"; echo ---; } >> '${log}'\n`;
  const script = (name: string, body: string) => {
    const p = join(scriptsDir, name);
    writeFileSync(p, `#!/bin/sh\n${body}`);
    chmodSync(p, 0o755);
    return p;
  };
  const fsmonitor = script('fsmonitor.sh', `${callers(markers.fsmonitor)}exit 1\n`);
  const external = script('external.sh', `${callers(markers.external)}exit 0\n`);
  const textconv = script('textconv.sh', `${callers(markers.textconv)}echo ${TEXTCONV_OUTPUT}\n`);

  write(dir, '.gitattributes', '*.tc diff=mark\n');
  write(dir, 't.tc', 'tracked one\n');
  commitAll(dir, 'baseline');
  git(dir, ['config', 'core.fsmonitor', fsmonitor]);
  git(dir, ['config', 'diff.external', external]);
  git(dir, ['config', 'diff.mark.textconv', textconv]);
  write(dir, 't.tc', 'tracked two\n');
  write(dir, 'u.tc', 'untracked one\n');

  const actual = porcelain(dir);
  const keys = actual.map((e) => `${e.xy}|${e.path}`).sort().join(',');
  if (keys !== ' M|t.tc,??|u.tc') seedFail('programs', `expected " M t.tc" and "?? u.tc", got ${JSON.stringify(actual)}`);

  git(dir, ['diff', '--', 't.tc']);
  git(dir, ['diff', '--no-ext-diff', '--', 't.tc']);
  for (const [name, log] of Object.entries(markers)) {
    if (!existsSync(log) || readFileSync(log, 'utf8').trim() === '') {
      seedFail('programs', `${name} did not run on a plain git call, so its log cannot prove anything`);
    }
    writeFileSync(log, '');
  }
  return markers;
}

/** The caller records a program's log holds (split on `---`), empty entries dropped. */
export function programRuns(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('---').map((s) => s.trim()).filter((s) => s.length > 0);
}
