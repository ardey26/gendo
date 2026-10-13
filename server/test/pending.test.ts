// server/test/pending.test.ts
import { describe, expect, it } from "vitest";
import { CML, Emulator, Lucid, generateEmulatorAccountFromPrivateKey } from "../../sdk/node_modules/@lucid-evolution/lucid/dist/index.js";
import { witness } from "../../sdk/src/core/cosign.js";
import { createApp } from "../src/app.js";
import { policy, signIn, store, wallet } from "./helpers.js";

// Real txs from the emulator: a payment that names owners as required signers.
async function world() {
  const a = wallet(), b = wallet(), c = wallet();
  const accs = [a, b, c].map((x) => generateEmulatorAccountFromPrivateKey({ lovelace: 100_000_000n }));
  const keys = [a, b, c].map((x, i) => ({ ...x, sk: accs[i]!.privateKey, pkh: CML.PrivateKey.from_bech32(accs[i]!.privateKey).to_public().hash().to_hex() }));
  const lucid = await Lucid(new Emulator(accs), "Custom");
  const [A, B, C] = keys.map((k) => ({ ...k, addressHex: CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(k.pkh))).to_address().to_hex() }));
  lucid.selectWallet.fromPrivateKey(A!.sk);
  const txFor = async (signers: string[]) => {
    let b = lucid.newTx().pay.ToAddress(accs[2]!.address, { lovelace: 2_000_000n });
    for (const s of signers) b = b.addSignerKey(s);
    return (await b.complete()).toCBOR();
  };
  const wit = (cbor: string, k: { sk: string }) => witness(lucid, cbor, k.sk);
  return { A: A!, B: B!, C: C!, txFor, wit };
}

describe("pending inbox", async () => {
  const { A, B, C, txFor, wit } = await world();
  const submitted: string[] = [];
  let submitResult: { ok: true; hash: string } | { ok: false; error: string } = { ok: true, hash: "h" };
  const app = createApp({
    store: store(),
    upstream: async () => new Response("{}", { status: 404 }),
    owners: async (p) => (p === policy ? [A.pkh, B.pkh, C.pkh] : undefined),
    submit: async (cbor) => (submitted.push(cbor), submitResult),
  });
  const session = async (k: typeof A) => ({ authorization: `Bearer ${(await (await signIn(app, k)).json()).token}`, "content-type": "application/json" });
  const post = (path: string, headers: Record<string, string>, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

  it("a proposal signed by every required signer at once is submitted straight away (single-owner pause)", async () => {
    const cbor = await txFor([A.pkh]);
    const r = await post(`/vaults/${policy}/pending`, await session(A), { cbor, witness: await wit(cbor, A), title: "Pause all agents" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "submitted", signedBy: [A.pkh], requiredSigners: [A.pkh] });
    expect(submitted).toHaveLength(1);
  });

  it("2 of 3: waits for the second owner, then submits once", async () => {
    submitted.length = 0;
    const cbor = await txFor([A.pkh, B.pkh]);
    const p = await (await post(`/vaults/${policy}/pending`, await session(A), { cbor, witness: await wit(cbor, A), title: "Raise the budget", recipe: { op: "edit" } })).json();
    expect(p).toMatchObject({ status: "open", signedBy: [A.pkh] });
    const inbox = await (await app.request("/me/pending", { headers: await session(B) })).json();
    expect(inbox.map((x: { id: string }) => x.id)).toContain(p.id);
    const done = await (await post(`/pending/${p.id}/witness`, await session(B), { witness: await wit(cbor, B) })).json();
    expect(done).toMatchObject({ status: "submitted", txHash: "h" });
    const again = await post(`/pending/${p.id}/witness`, await session(B), { witness: await wit(cbor, B) });
    expect((await again.json()).status).toBe("submitted");
    expect(submitted).toHaveLength(1);
  });

  it("refuses a witness from an owner who isn't a required signer, and stores nothing", async () => {
    const cbor = await txFor([A.pkh, B.pkh]);
    const p = await (await post(`/vaults/${policy}/pending`, await session(A), { cbor, witness: await wit(cbor, A), title: "t" })).json();
    expect((await post(`/pending/${p.id}/witness`, await session(C), { witness: await wit(cbor, C) })).status).toBe(403);
    const row = (await (await app.request(`/vaults/${policy}/pending`, { headers: await session(A) })).json()).find((x: { id: string }) => x.id === p.id);
    expect(row.signedBy).toEqual([A.pkh]);
  });

  it("refuses a witness for another body, and a proposal whose signers aren't all owners", async () => {
    const cbor = await txFor([A.pkh, B.pkh]);
    const other = await txFor([A.pkh, B.pkh, C.pkh]);
    expect((await post(`/vaults/${policy}/pending`, await session(A), { cbor, witness: await wit(other, A), title: "t" })).status).toBe(400);
    const stranger = wallet();
    const bad = await txFor([A.pkh, stranger.pkh]);
    expect((await post(`/vaults/${policy}/pending`, await session(A), { cbor: bad, witness: await wit(bad, A), title: "t" })).status).toBe(400);
  });

  it("a rejected submit marks it failed with the node's reason and doesn't retry", async () => {
    submitted.length = 0;
    submitResult = { ok: false, error: "BadInputsUTxO" };
    const cbor = await txFor([A.pkh]);
    const p = await (await post(`/vaults/${policy}/pending`, await session(A), { cbor, witness: await wit(cbor, A), title: "t" })).json();
    expect(p).toMatchObject({ status: "failed", error: "BadInputsUTxO" });
    expect((await post(`/pending/${p.id}/witness`, await session(A), { witness: await wit(cbor, A) })).status).toBe(409);
    expect(submitted).toHaveLength(1);
    submitResult = { ok: true, hash: "h" };
  });
});

describe("agent requests", async () => {
  const { A, B, C, txFor, wit } = await world();
  const agent = wallet();
  const unitX = policy + "11".repeat(28);
  const unitY = policy + "22".repeat(28);
  const db = store();
  db.put({ policy, name: "Acme payouts", listed: true }); // labels show on a registered vault's listing
  // Requests must move the allowance token: these fake txs name the unit in a tagged output.
  const app = createApp({
    store: db,
    upstream: async () => new Response("{}", { status: 404 }),
    owners: async (p) => (p === policy ? [A.pkh, B.pkh, C.pkh] : undefined),
    submit: async () => ({ ok: true, hash: "h" }),
    unitsMoved: (cbor: string) => (cbor === "" ? [] : [unitX]),
  });
  const session = async (k: typeof A) => ({ authorization: `Bearer ${(await (await signIn(app, k)).json()).token}`, "content-type": "application/json" });
  const post = (path: string, headers: Record<string, string>, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

  it("an owner issues a token; the agent posts its request with its own signature; owners see it", async () => {
    const { token } = await (await post(`/vaults/${policy}/agents/${unitX}/token`, await session(A), {})).json();
    expect(token).toMatch(/^gnd_[0-9a-f]{64}$/);
    const cbor = await txFor([A.pkh, B.pkh, agent.pkh]);
    const agentWit = await wit(cbor, agent as unknown as { sk: string });
    const r = await post("/requests", { authorization: `Bearer ${token}`, "content-type": "application/json" }, { cbor, agentWitness: agentWit, intentId: "INV-2", purpose: "hosting", reason: "annual plan" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ kind: "request", status: "open", signedBy: [agent.pkh], recipe: { intentId: "INV-2", purpose: "hosting", reason: "annual plan" } });
  });

  it("a token for allowance Y can't post a request that moves allowance X", async () => {
    const { token } = await (await post(`/vaults/${policy}/agents/${unitY}/token`, await session(A), {})).json();
    const cbor = await txFor([A.pkh, B.pkh, agent.pkh]);
    const r = await post("/requests", { authorization: `Bearer ${token}`, "content-type": "application/json" }, { cbor, agentWitness: await wit(cbor, agent as unknown as { sk: string }), intentId: "I", purpose: "p", reason: "r" });
    expect(r.status).toBe(403);
  });

  it("rotating a token kills the old one; a bad token gets 401", async () => {
    const t1 = (await (await post(`/vaults/${policy}/agents/${unitX}/token`, await session(A), {})).json()).token;
    await post(`/vaults/${policy}/agents/${unitX}/token`, await session(A), {});
    const cbor = await txFor([A.pkh, agent.pkh]);
    expect((await post("/requests", { authorization: `Bearer ${t1}`, "content-type": "application/json" }, { cbor, agentWitness: "00", intentId: "I", purpose: "p", reason: "r" })).status).toBe(401);
  });

  it("owners name agents; the public listing shows the names", async () => {
    expect((await app.request(`/vaults/${policy}/agents/${unitX}/label`, { method: "PUT", headers: await session(B), body: JSON.stringify({ name: "payout-bot" }) })).status).toBe(200);
    expect((await (await app.request(`/public/${policy}`)).json()).agents).toEqual({ [unitX]: "payout-bot" });
  });
});
