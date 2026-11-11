/** Base64 for the bridge to the plugin's code (messages carry text only). */

/** `bytes` as standard, padded base64. Converts in slices: one `apply` of a
 * 2 MiB array would overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  const slice = 0x8000;
  let text = "";
  for (let i = 0; i < bytes.length; i += slice) {
    text += String.fromCharCode(...bytes.subarray(i, i + slice));
  }
  return btoa(text);
}

/** The bytes `text` encodes; throws on anything that is not base64. */
export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}
