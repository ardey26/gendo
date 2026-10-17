// The keyless server. The session token lives in sessionStorage (this tab only).
import type { PendingView } from "./types.ts";

export const SERVER_DOWN = "Our server is unreachable. Approvals are paused; your funds are untouched, and the CLI still works.";
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
export type Session = { token: string; pkh: string; walletId: string };
const KEY = "gendo.session";
export const session = {
  get(): Session | undefined {
    try {
      const s = sessionStorage.getItem(KEY);
      return s ? (JSON.parse(s) as Session) : undefined;
    } catch {
      return undefined;
    }
  },
  set(s: Session) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // private mode: the session lasts this page only
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // nothing stored
    }
  },
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = session.get();
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      headers: { "content-type": "application/json", ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    globalThis.dispatchEvent?.(new Event("gendo:server-down"));
    throw new ApiError(0, SERVER_DOWN);
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (r.status === 401) session.clear();
  if (!r.ok) throw new ApiError(r.status, j.error ?? `the server answered ${r.status}`);
  return j as T;
}

export type Pairing = {
  id: string; policy: string; name: string; expiresAt: number;
  status: "open" | "claimed" | "confirmed" | "ready" | "expired" | "cancelled";
  words?: string; agent?: string;
};
export type MyVault = { policy: string; vaultId: string; name: string | null; listed: boolean };
export const api = {
  challenge: (address: string) => call<{ nonce: string; payload: string }>("POST", "/auth/challenge", { address }),
  verify: (nonce: string, signed: { signature: string; key: string }) => call<{ token: string; pkh: string; expiresAt: number }>("POST", "/auth/verify", { nonce, ...signed }),
  myVaults: () => call<MyVault[]>("GET", "/me/vaults"),
  addVault: (vaultId: string) => call<{ policy: string; vaultId: string }>("POST", "/me/vaults", { vaultId }),
  setListing: (policy: string, name: string, listed: boolean) => call<unknown>("PUT", `/vaults/${policy}/listing`, { name, listed }),
  myPending: () => call<PendingView[]>("GET", "/me/pending"),
  pendingOf: (policy: string) => call<PendingView[]>("GET", `/vaults/${policy}/pending`),
  propose: (policy: string, p: { cbor: string; witness: string; title: string; recipe: unknown }) => call<PendingView>("POST", `/vaults/${policy}/pending`, p),
  createVault: (p: { cbor: string; witness: string; name: string }) => call<{ pending: PendingView; vaultId: string; policy: string }>("POST", "/vaults", p),
  suggestedVaults: () => call<{ policy: string; vaultId: string; name: string | null }[]>("GET", "/me/suggested-vaults"),
  createPairing: (policy: string, name: string) => call<{ id: string; code: string; expiresAt: number }>("POST", `/vaults/${policy}/pairings`, { name }),
  pairing: (id: string) => call<Pairing>("GET", `/pairings/${id}`),
  confirmPairing: (id: string) => call<Pairing>("POST", `/pairings/${id}/confirm`),
  cancelPairing: (id: string) => call<Pairing>("POST", `/pairings/${id}/cancel`),
  sign: (id: string, witness: string) => call<PendingView>("POST", `/pending/${id}/witness`, { witness }),
  agentToken: (policy: string, unit: string) => call<{ token: string }>("POST", `/vaults/${policy}/agents/${unit}/token`, {}),
  setLabel: (policy: string, unit: string, name: string) => call<unknown>("PUT", `/vaults/${policy}/agents/${unit}/label`, { name }),
  listing: async (policy: string) => {
    const r = await fetch(`/public/${policy}`).catch(() => undefined);
    return r?.ok ? ((await r.json()) as { name: string; listed: boolean; agents: Record<string, string> }) : undefined;
  },
};
