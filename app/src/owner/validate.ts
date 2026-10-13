// The agent editor's rules: the chain's own (is_well_formed) plus what makes a form usable.
import { MAX_DESTINATIONS } from "../../../sdk/src/core/limits.ts";

export type AgentForm = { name: string; agentKey: string; perPayment: string; budget: string; period: "day" | "week" | "month"; payees: string[]; expires: string; fund: string };
export const PERIOD_MS = { day: 86_400_000n, week: 604_800_000n, month: 2_592_000_000n } as const;

/** Decimal ADA to lovelace, exactly; undefined for anything else. */
export function toLovelace(s: string): bigint | undefined {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s.trim());
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0") : undefined;
}

export function agentProblems(f: AgentForm, o: { isNew: boolean; nowMs: number; owners: string[]; isKeyAddress: (s: string) => boolean }): string[] {
  const p: string[] = [];
  const cap = toLovelace(f.perPayment);
  const budget = toLovelace(f.budget);
  if (cap === undefined || cap === 0n) p.push("Set a per-payment cap above 0 ADA.");
  if (budget === undefined || budget === 0n) p.push("Set a budget above 0 ADA.");
  if (cap && budget && cap > budget) p.push("The per-payment cap can't be above the budget: the chain refuses it.");
  if (!f.payees.length) p.push("Add at least one payee.");
  if (f.payees.length > MAX_DESTINATIONS) p.push(`At most ${MAX_DESTINATIONS} payees.`);
  for (const a of f.payees) if (!o.isKeyAddress(a)) p.push(`${a.slice(0, 20)}… isn't a wallet address on this network (script addresses can't be payees).`);
  if (new Set(f.payees).size !== f.payees.length) p.push("A payee is listed twice.");
  const exp = Date.parse(`${f.expires}T23:59:59Z`);
  if (!Number.isFinite(exp) || exp <= o.nowMs) p.push("Pick an expiry date in the future.");
  if (o.isNew) {
    if (!f.name.trim()) p.push("Name the agent.");
    if (!/^[0-9a-f]{56}$/.test(f.agentKey)) p.push("The agent key hash is 56 hex characters (cli/vault keys show agent).");
    else if (o.owners.includes(f.agentKey)) p.push("The agent key can't be an owner key.");
    if (toLovelace(f.fund) === undefined) p.push("Fund it with an ADA amount (0 for none).");
  }
  return p;
}
