import type { Liveness } from "../../../sdk/src/core/index.ts";
import type { Detail } from "./diff.ts";
import type { PendingView } from "./types.ts";

export type Status = { label: string; tone: "seal" | "fill" | "dead" | "plain"; canSign: boolean; canRebuild: boolean; needsYou: boolean; left?: string };

const leftText = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 60 * 24 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h left` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
};

export function statusOf(p: PendingView, live: Liveness | undefined, viewer: string, nowMs: number): Status {
  const rebuildable = p.kind === "proposal" && p.recipe != null && p.requiredSigners.includes(viewer);
  if (p.status === "landed" || live?.state === "landed") return { label: "Landed", tone: "plain", canSign: false, canRebuild: false, needsYou: false };
  if (p.status === "failed") return { label: `Failed: ${p.error ?? "the node refused it"}`, tone: "dead", canSign: false, canRebuild: rebuildable, needsYou: false };
  if (p.status === "submitting" || p.status === "submitted") return { label: "Waiting for the chain", tone: "fill", canSign: false, canRebuild: false, needsYou: false };
  if (live?.state === "dead") return { label: `Dead: ${live.reason}`, tone: "dead", canSign: false, canRebuild: rebuildable, needsYou: false };
  const mine = p.requiredSigners.includes(viewer) && !p.signedBy.includes(viewer);
  return {
    label: `${p.signedBy.filter((k) => p.requiredSigners.includes(k)).length} of ${p.requiredSigners.length} signatures`,
    tone: "seal",
    canSign: mine && live?.state === "submittable",
    canRebuild: false,
    needsYou: mine && live?.state === "submittable",
    ...(live?.state === "submittable" ? { left: leftText(live.expiresAtMs - nowMs) } : {}),
  };
}

/** Anything the explanation warns about needs a second, explicit confirm before signing. */
export const needsConfirm = (d: Detail) => d.warnings.length > 0;

/** Worth re-checking: on its way to the chain, or signed by me and waiting for the others. */
export const inFlight = (rows: PendingView[], viewer: string) =>
  rows.some((p) => p.status === "submitting" || p.status === "submitted" || (p.status === "open" && p.signedBy.includes(viewer)));
