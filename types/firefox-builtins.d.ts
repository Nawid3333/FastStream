/**
 * JavaScript built-ins Firefox has that TypeScript's library does not describe yet.
 * Ambient, like messages.d.ts: no import or export.
 */

interface Uint8Array {
  /** The bytes in base64 (Firefox 133; the Uint8Array to/from base64 proposal). */
  toBase64(options?: {alphabet?: 'base64' | 'base64url', omitPadding?: boolean}): string;
}
