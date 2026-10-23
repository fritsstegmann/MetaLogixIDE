/**
 * Encoding for values stored in the OS credential store through keytar.
 *
 * Plaintext gnome-keyring writes a secret raw but unescapes `\n` and `\\` when it
 * reads it back, so any stored value containing a backslash or control character
 * does not round-trip and can break the keyring file. Stored values are therefore
 * base64 behind a version prefix.
 */

/** Prefix that marks a value written by {@link encodeStoredSecret}. */
export const STORED_SECRET_PREFIX = 'b64v1:';

/** Result of decoding a stored value; `legacy` is true when the value predates the encoding. */
export interface DecodedStoredSecret {
  readonly text: string;
  readonly legacy: boolean;
}

/** Encodes text into a form containing only the prefix and base64 characters. */
export function encodeStoredSecret(text: string): string {
  void text;
  throw new Error('not implemented');
}

/** Decodes a stored value; unprefixed values pass through as legacy, malformed prefixed values throw. */
export function decodeStoredSecret(stored: string): DecodedStoredSecret {
  void stored;
  throw new Error('not implemented');
}
