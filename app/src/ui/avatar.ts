// A stable color per agent or vault: the hue comes from a hash of its id, so it's the same on every
// page and every device. Reds are left out; the app keeps red for warnings and things that need you.

/** FNV-1a over the id, mapped to one of ten hues 30° apart in [30, 330): neighbors stay tellable apart. */
export function seedHue(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 30 + 30 * (h % 10);
}
