#!/usr/bin/env node
// Deterministic fake `claude` CLI used in tests. Echoes stdin lines and
// responds to /model, /size and /flood. On --continue, prints a "resumed"
// banner.
// `/size` prints the PTY's current columns x rows as seen by this process
// (updated on SIGWINCH), so tests can check what size the PTY really has.
// `/flood [kb]` mimics how Claude Code's TUI draws: see flood() below.
const args = process.argv.slice(2);
const isContinue = args.includes('--continue');

// Text of the /flood footer. Tests match these exactly.
const INPUT_BOX = '| > INPUT-BOX-MARK';
const STATUS_PREFIX = 'STATUS-LINE-MARK model=mock tokens=';
const pad6 = (n) => String(n).padStart(6, '0');

/**
 * Full-screen TUI redraw that only ever patches cells, like Claude Code (Ink):
 *   1. clear the screen, draw an input box on row rows-1 and a status line on
 *      the last row — once;
 *   2. write more than `kb` KiB of content lines into rows 1..rows-2 with
 *      absolute cursor addressing (cycling, never scrolling — no newline is
 *      ever written), patching only the status line's token counter digits
 *      every 50 lines;
 *   3. write `FLOOD-END lines=<n> bytes=<b> size=<cols>x<rows>` on row 1 and
 *      leave the cursor at the end of it.
 * Nothing is printed afterwards (no prompt), so the screen stays exactly as
 * drawn: the input box and status line text exist only in the first few
 * bytes of the flood, far outside a raw tail of the last 256 KiB.
 */
function flood(kb) {
  const cols = process.stdout.columns || 80;
  const rows = Math.max(3, process.stdout.rows || 24);
  const width = Math.max(20, Math.min(cols - 1, 72));
  const contentRows = rows - 2;
  const counterCol = STATUS_PREFIX.length + 1;
  const target = kb * 1024;

  let bytes = 0;
  const emit = (s) => { bytes += s.length; process.stdout.write(s); };

  emit(
    '\x1b[2J\x1b[H' +
    `\x1b[${rows - 1};1H\x1b[2K${INPUT_BOX.slice(0, width)}` +
    `\x1b[${rows};1H\x1b[2K${(STATUS_PREFIX + pad6(0)).slice(0, width)}`,
  );

  let n = 0;
  while (bytes < target) {
    let chunk = '';
    for (let k = 0; k < 200; k++, n++) {
      const row = 1 + (n % contentRows);
      const text = `flood ${pad6(n)} `.padEnd(width, 'x');
      chunk += `\x1b[${row};1H\x1b[2K${text}`;
      if (n % 50 === 49) chunk += `\x1b[${rows};${counterCol}H${pad6(n + 1)}`;
    }
    emit(chunk);
  }
  // Final counter patch, then the end marker on row 1.
  emit(`\x1b[${rows};${counterCol}H${pad6(n)}`);
  emit(`\x1b[1;1H\x1b[2KFLOOD-END lines=${n} bytes=${bytes} size=${cols}x${rows}`);
}

process.stdout.write(isContinue ? 'mock-claude resumed\n> ' : 'mock-claude ready\n> ');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const line = String(chunk).trim();
  if (line.startsWith('/model ')) {
    process.stdout.write(`model set to ${line.slice(7)}\n> `);
  } else if (line === '/size') {
    process.stdout.write(`size: ${process.stdout.columns}x${process.stdout.rows}\n> `);
  } else if (line === '/flood' || line.startsWith('/flood ')) {
    const kb = Number(line.slice(6).trim());
    flood(Number.isFinite(kb) && kb > 0 ? kb : 512);
  } else if (line === 'exit' || line === '/quit') {
    process.exit(0);
  } else {
    process.stdout.write(`echo: ${line}\n> `);
  }
});
