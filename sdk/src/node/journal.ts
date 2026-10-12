// The operator's intent journal on disk (Node only).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { IntentJournal, JournalEntry } from "../core/idempotency.js";

/** Append-only JSONL file; the last entry for an id wins. Keep it next to the agent's state, durably. */
export class FileJournal implements IntentJournal {
  constructor(private readonly path: string) {}
  private entries(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  get(intentId: string) {
    return this.entries().filter((e) => e.intentId === intentId).pop();
  }
  put(e: JournalEntry) {
    appendFileSync(this.path, JSON.stringify(e) + "\n");
  }
}
