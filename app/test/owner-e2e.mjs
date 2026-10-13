// app/test/owner-e2e.mjs: two owners, two browsers, one vault (2 of 2), on the devnet.
// Env: APP (server URL), VAULT_ID, POLICY, UNIT, KEY_A, KEY_B (bech32 test keys).
import { browser } from "./driver.mjs";
const { APP, VAULT_ID, POLICY, UNIT, KEY_A, KEY_B } = process.env;
const ok = (m) => console.log(`  ok  ${m}`);
const A = await browser(9341);
const B = await browser(9342);
const signIn = async (b, key) => {
  await b.open(`${APP}/?testwallet=${key}`);
  await b.click(/Test wallet\s+Detected/);
  await b.waitText(/Your agent wallets/);
  await b.fill("vid", VAULT_ID);
  await b.click(/^Add vault$/);
  await b.waitText(/Unnamed vault|E2E payouts/);
};
try {
  await signIn(A, KEY_A);
  ok("owner A signed in with a wallet signature and added the vault by id");
  await signIn(B, KEY_B);
  ok("owner B too, in its own browser");

  await A.open(`${APP}/v/${POLICY}`);
  await A.click(/^Pause all agents$/);
  await A.waitText(/Review before signing[\s\S]*Pause all agents[\s\S]*Paused\s+no\s+yes/);
  await A.click(/^Sign with wallet$/);
  await A.waitText(/Pause sent/);
  for (let i = 0; i < 40; i++) {
    await A.open(`${APP}/v/${POLICY}`);
    const t = await A.waitText(/Active|Paused/);
    if (/All agents are paused/.test(t)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await A.waitText(/All agents are paused/);
  ok("one owner paused the vault alone, after reviewing it in the browser; it landed");

  await A.open(`${APP}/v/${POLICY}/settings`);
  await A.waitText(/Who signs/);
  await A.click(/^Propose unpause$/);
  await A.waitText(/Review before signing[\s\S]*Paused\s+yes\s+no/);
  await A.click(/^Sign with wallet$/);
  await A.waitText(/Unpause proposed/);
  ok("owner A proposed the unpause, naming owner B");

  await B.open(`${APP}/inbox`);
  await B.waitText(/Unpause/);
  await B.waitText(/Paused\s+yes\s+no/);
  await B.click(/^Sign with wallet$/);
  await B.waitText(/Waiting for the chain|Landed/);
  ok("owner B saw the change computed from the chain (paused yes → no) and signed it");
  for (let i = 0; i < 40; i++) {
    await A.open(`${APP}/v/${POLICY}`);
    const t = await A.waitText(/Active|Paused/);
    if (!/All agents are paused/.test(t)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  ok("the vault is active again");

  await A.open(`${APP}/v/${POLICY}/agents/${UNIT}`);
  await A.waitText(/On-chain now[\s\S]*25 ADA per day/); // the allowance has loaded from the chain
  await A.fill("budget", "40");
  await A.waitText(/40 ADA per day/);
  await A.click(/^Propose change$/);
  await A.waitText(/Review before signing[\s\S]*Budget\s+25 ADA \/ day\s+40 ADA \/ day/);
  await A.click(/^Sign with wallet$/);
  await A.waitText(/Proposed\. Signed by you: 1 of 2/);
  ok("owner A proposed a budget raise in the agent editor, after reviewing the diff computed in the browser");
  await B.open(`${APP}/inbox`);
  await B.waitText(/Budget\s+25 ADA \/ day\s+40 ADA \/ day/);
  await B.click(/^Sign with wallet$/);
  await B.waitText(/Waiting for the chain|Landed/);
  ok("owner B saw 25 → 40 ADA a day in the diff and signed");
  for (let i = 0; i < 40; i++) {
    await A.open(`${APP}/w/${POLICY}`);
    const t = await A.waitText(/Agents/);
    if (/40 ADA per day/.test(t)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await A.waitText(/40 ADA per day/);
  ok("the public page shows the new budget from the chain");
  console.log("PASS");
} finally {
  A.close();
  B.close();
}
