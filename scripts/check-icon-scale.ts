/**
 * Icon scale check, for slice-level use: `node scripts/check-icon-scale.ts [file ...]`.
 * Prints `file:line rule message` per violation and exits 1 when there is any.
 * With no arguments it scans every `src/renderer/**\/*.tsx`. CI enforcement is
 * the unit test `tests/unit/renderer/icon-scale-tree.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { iconScaleViolations } from '../tests/support/icon-scale.ts';

const root = resolve(import.meta.dirname, '..');

function rendererFiles(): string[] {
  const dir = join(root, 'src/renderer');
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(dir, f));
}

const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f)) : rendererFiles();
let count = 0;
for (const file of files) {
  const rel = relative(root, file);
  for (const v of iconScaleViolations(rel, readFileSync(file, 'utf8'))) {
    const [line, ...rest] = v.split(' ');
    console.log(`${rel}:${line} ${rest.join(' ')}`);
    count++;
  }
}
console.log(`${count} violation(s) in ${files.length} file(s)`);
process.exit(count > 0 ? 1 : 0);
