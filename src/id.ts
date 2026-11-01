/**
 * Returns a random v4 UUID, preferring `crypto.randomUUID`, then
 * `crypto.getRandomValues` (available outside secure browser contexts), and
 * only then `Math.random`.
 */
export function generateId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
