/** Settings nav footer text: the "MetaLogix IDE" wordmark plus the running app version when known. */

const WORDMARK = 'MetaLogix IDE';

/** Footer label for `version`; null or empty yields the wordmark alone. */
export function versionLabel(version: string | null): string {
  return version ? `${WORDMARK} ${version}` : WORDMARK;
}

/**
 * Reads the app version through `invoke`, resolving to null instead of rejecting when the call
 * fails, because the footer degrades to the wordmark and the spec forbids surfacing that error.
 */
export async function readAppVersion(
  invoke: () => Promise<{ version: string }>,
): Promise<string | null> {
  try {
    const { version } = await invoke();
    return version;
  } catch {
    return null;
  }
}
