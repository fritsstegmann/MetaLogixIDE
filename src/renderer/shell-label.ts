/**
 * Chip text for a shell: its launch name, plus a " N" suffix when the same
 * name runs more than once in the project. Unknown index → ''.
 */
export function shellChipLabel(
  shells: readonly { readonly shellIndex: number; readonly launchName: string }[],
  shellIndex: number,
): string {
  const shell = shells.find((s) => s.shellIndex === shellIndex);
  if (!shell) return '';
  const dupes = shells.filter((s) => s.launchName === shell.launchName);
  return dupes.length > 1 ? `${shell.launchName} ${dupes.indexOf(shell) + 1}` : shell.launchName;
}

/**
 * Shells shown as chips in the tab strip. The split's right shell is not a
 * tab while it sits in the split; "To tab" clears `rightShellIndex` and it
 * reappears here.
 */
export function stripShells<T extends { readonly shellIndex: number }>(
  shells: readonly T[],
  rightShellIndex: number | null,
): T[] {
  if (rightShellIndex === null || rightShellIndex === 0) return [...shells];
  return shells.filter((s) => s.shellIndex !== rightShellIndex);
}
