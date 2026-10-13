// Hex helpers that work in Node and in the browser (no Buffer).
export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error(`not hex: ${hex.slice(0, 16)}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const utf8ToHex = (s: string): string => toHex(new TextEncoder().encode(s));
export const hexToUtf8 = (hex: string): string => new TextDecoder().decode(fromHex(hex));
