// Version comparison for gendo-agent releases (x.y.z, numbers only).
const parts = (v: string | undefined) => (v && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : undefined);

/** True when `v` is older than `than`. An unreadable version counts as older: an agent too old to say. */
export function olderThan(v: string | undefined, than: string): boolean {
  const a = parts(v), b = parts(than)!;
  if (!a) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}
