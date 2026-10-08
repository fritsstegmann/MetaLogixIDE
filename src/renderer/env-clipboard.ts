/** Copies env values to the clipboard and reports the outcome without ever echoing the value or name. */

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export type CopyNotify = (kind: 'success' | 'error', title: string) => void;

/** Writes the raw value; notifies ENV_COPY.copied or ENV_COPY.copyFailed (never the value or name). Resolves true on success. */
export function copyEnvValue(
  value: string,
  clipboard: ClipboardWriter,
  notify: CopyNotify,
): Promise<boolean> {
  void value;
  void clipboard;
  void notify;
  throw new Error('copyEnvValue not implemented');
}

/** copyEnvValue bound to navigator.clipboard and the toast bus — what components call. */
export function copyEnvValueToClipboard(value: string): Promise<boolean> {
  void value;
  throw new Error('copyEnvValueToClipboard not implemented');
}
