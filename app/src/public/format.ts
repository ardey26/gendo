// app/src/public/format.ts
import type { AllowanceView } from "../../../sdk/src/read/index.ts";

export const parsePolicy = (path: string): string | undefined => /^\/w\/([0-9a-f]{56})\/?$/.exec(path)?.[1];

export function ada(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function periodName(ms: bigint): string {
  const units: [string, bigint][] = [["week", 604_800_000n], ["day", 86_400_000n], ["hour", 3_600_000n], ["minute", 60_000n], ["second", 1_000n]];
  for (const [name, u] of units) if (ms % u === 0n) return ms === u ? name : `${ms / u} ${name}s`;
  return `${ms} ms`;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function allowanceSentence(a: AllowanceView): string {
  if (a.status === "malformed") return "Malformed: the agent can't spend it, and owners can reclaim it.";
  const l = a.caps.find((c) => c.unit === "lovelace");
  const n = a.payees.length;
  const limits = l ? `up to ${ada(l.perPayment)} ADA at a time and ${ada(l.perPeriod)} ADA per ${periodName(a.periodMs!)}` : "nothing (no ADA limit is set)";
  return `This agent can pay ${limits}, only to ${n === 1 ? "this address" : `these ${n} addresses`}, until ${date(a.expiresAt!)}.`;
}
