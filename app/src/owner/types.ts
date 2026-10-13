export type Net = "Preprod" | "Custom";
/** The server's inbox row (server/src/pending.ts). Display data only: what a tx does is recomputed from the chain. */
export type PendingView = {
  id: string; policy: string; kind: "proposal" | "request"; title: string; cbor: string; recipe: unknown;
  requiredSigners: string[]; signedBy: string[]; status: "open" | "submitting" | "submitted" | "landed" | "failed";
  txHash?: string; error?: string; createdBy: string; createdAt: number;
};
