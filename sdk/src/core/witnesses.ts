// sdk/src/core/witnesses.ts
// One tx body, many signers, no provider: the server checks what owners upload and
// assembles at the threshold. Merging mirrors Lucid's assemble, so the body (and with
// it every signature) is untouched.
import { CML } from "@lucid-evolution/lucid";

const parse = (txCbor: string) => CML.Transaction.from_cbor_hex(txCbor);

export const bodyHash = (txCbor: string) => CML.hash_transaction(parse(txCbor).body()).to_hex();

export function requiredSignersOf(txCbor: string): string[] {
  const rs = parse(txCbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; rs && i < rs.len(); i++) out.push(rs.get(i).to_hex());
  return out;
}

/** Key hashes whose signatures in this witness set are valid over this tx's body. */
export function verifiedSigners(txCbor: string, witnessSetCbor: string): string[] {
  const hash = CML.hash_transaction(parse(txCbor).body()).to_raw_bytes();
  const vk = CML.TransactionWitnessSet.from_cbor_hex(witnessSetCbor).vkeywitnesses();
  const out: string[] = [];
  for (let i = 0; vk && i < vk.len(); i++) {
    const w = vk.get(i);
    if (!w.vkey().verify(hash, w.ed25519_signature())) throw new Error("a signature in this witness doesn't match the transaction");
    out.push(w.vkey().hash().to_hex());
  }
  if (!out.length) throw new Error("this witness holds no signature");
  return out;
}

export function withWitnesses(txCbor: string, witnessSets: string[]): string {
  const tx = parse(txCbor);
  const b = CML.TransactionWitnessSetBuilder.new();
  const existing = tx.witness_set();
  b.add_existing(existing);
  const datums = existing.plutus_datums();
  for (let i = 0; datums && i < datums.len(); i++) b.add_plutus_datum(datums.get(i));
  for (const w of witnessSets) b.add_existing(CML.TransactionWitnessSet.from_cbor_hex(w));
  return CML.Transaction.new(tx.body(), b.build(), true, tx.auxiliary_data()).to_cbor_hex();
}
