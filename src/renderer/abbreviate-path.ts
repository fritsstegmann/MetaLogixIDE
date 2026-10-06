/**
 * Fish-style path abbreviation for narrow labels: the macOS home prefix
 * becomes `~`, every leading segment shrinks to its first character (two
 * for hidden `.dirs`), and the last segment, the one that identifies the
 * folder, stays whole. `/Users/me/Projects/Personal/acme` → `~/P/P/acme`.
 */
export function abbreviatePath(path: string): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
  const home = /^\/Users\/[^/]+/u.exec(trimmed);
  const prefix = home ? '~' : '';
  const rest = home ? trimmed.slice(home[0].length) : trimmed;
  const segments = rest.split(sep);
  const last = segments.length - 1;
  return prefix + segments
    .map((segment, i) => (i === last || segment === '' || /^[A-Za-z]:$/u.test(segment) ? segment : initial(segment)))
    .join(sep);
}

/** First character of a segment by code point; hidden segments keep their leading dot. */
function initial(segment: string): string {
  const chars = Array.from(segment);
  return chars[0] === '.' && chars.length > 1 ? chars.slice(0, 2).join('') : chars[0] ?? '';
}
