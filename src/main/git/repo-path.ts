/**
 * Path containment rules for every git read and working-tree read the Diff tab and Git panel make
 * (spec AC31, AC43). `toRepoRelativePath` is the lexical rule applied before any git call;
 * `assertWorktreeContained` is the on-disk rule that also defeats directory symlinks.
 */
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** A renderer-supplied path that resolves outside the project; no git command or file read may follow. */
export class PathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathRejectedError';
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Validate `input` lexically against `root` and return it normalised, relative to `root`, with `/`
 * separators. Rejects non-strings, empty, NUL, absolute, root-equal and escaping paths, including a
 * sibling folder whose name starts with the project's name. Throws `PathRejectedError`.
 */
export function toRepoRelativePath(root: string, input: string): string {
  if (typeof input !== 'string' || input === '' || input.includes('\0')) throw new PathRejectedError('invalid path');
  if (isAbsolute(input)) throw new PathRejectedError('absolute paths are not allowed');
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, input);
  if (abs === rootAbs || !isInside(rootAbs, abs)) throw new PathRejectedError('path escapes project root');
  return relative(rootAbs, abs).split(sep).join('/');
}

function nearestExistingRealpath(start: string, stop: string, realpath: (p: string) => string): string {
  let current = start;
  for (;;) {
    try {
      return realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || current === stop) throw err;
      current = dirname(current);
    }
  }
}

/**
 * Require the real path of `rel`'s parent folder (or of its nearest existing ancestor) to lie inside
 * the real project root, so a path through a symlinked folder that leads out is rejected. `rel` must
 * already be lexically valid. Throws `PathRejectedError`; other realpath failures propagate.
 */
export function assertWorktreeContained(root: string, rel: string, realpath: (p: string) => string = realpathSync): void {
  const rootAbs = resolve(root);
  const realRoot = realpath(rootAbs);
  const parentReal = nearestExistingRealpath(dirname(resolve(rootAbs, rel)), rootAbs, realpath);
  if (!isInside(realRoot, parentReal)) throw new PathRejectedError('path escapes project root through a symlink');
}
