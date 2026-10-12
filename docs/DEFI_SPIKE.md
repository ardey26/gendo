# Design spike: DeFi inside the vault

**Status:** reviewed 2026-10-05. Decisions in §0. Slice 1 is approved, but no code until the three open verifications (§10) are settled. Research date 2026-10-05; every protocol claim is sourced from that protocol's own repo (§9).

**North star.** An owner delegates a yield strategy to an agent and keeps a kill switch; on revocation they get everything back.

**Invariant.** The vault owns every position the agent opens. The agent key never owns anything except its own fee and collateral UTxOs.

## 0. Review decisions
- **Slice 1 approved, verifications first.** Start with the three open verifications (§10); no code until all three are settled.
- **Co-signed path in slice 1.** `CoSignedSpend` refuses script (order) destinations. Treasury-funded orders are defined in slice 2, with owner-only cancel.
- **Turnover budget.** The cap stays turnover-based and is renamed **"turnover budget"** in datum docs and the SDK. Stated plainly: **proceeds and refunds never restore headroom.**
- **Slice 3: claim and spend are separate txs.** An `AgentClaim` tx may not also pay anything out. This keeps "outflow = allowance input − continuing output" exact, with no claimed value in the arithmetic. Tested by a claim-plus-payment tx that must fail.
- **Slice 3 LP caps.** A cap on an LP token must be expressible in the underlying asset. If it isn't, LP actions default to owner co-sign.
- **Slice 4 cut.** It is replaced by a written gate: a lending protocol with a **live preprod deployment** and **verified script-compatible redemption**. No self-deployed protocols.
- **CDP exclusion** accepted as written.
- **Estimates doubled** (§8).
- **Every slice ends with** the budget measured on preprod, plus an audit-scope diff.

## 1. Findings that shape the design

| Protocol | Kind | Preprod | Can a *script* be the owner? | Verdict |
|---|---|---|---|---|
| **Minswap V2** | DEX (batcher orders) | **Yes**: `deployed/preprod/` | **Yes.** `canceller: OrderAuthorizationMethod` = `OAMSignature`, `OAMSpendScript`, `OAMWithdrawScript` or `OAMMintScript`. Script receiver and refund via `Address` + `EODNoDatum`/hash/inline. Anyone can cancel after expiry, with the refund going to `refund_receiver`. | **Slice 1 target** |
| SundaeSwap V3 | DEX | Not found (SDK queries an API) | Yes: `MultisigScript.Script(hash)` = withdraw-zero | Later alternative |
| WingRiders V2 | DEX | Not found | **No**: `Reclaim` calls `paddressPubKeyCredential`, which is `perror` for a script. A script-owned order can never be reclaimed. | **Exclude** |
| Splash | DEX | Limit orders only | **No**: `cancellation_pkh` key only; LP rewards are pubkey-only (`getRewardValue'`) | **Exclude** |
| Lenfi (ex-Aada) v1 | Lending (pooled, bearer LP) | Not verified | Yes: receipt = fungible LP token, and redemption checks no signature. Order `control_credential: Credential`. | Plutus V2, stale since Jan 2025; would need self-deployment |
| Liqwid v2 | Lending (qTokens) | None | **Can't verify**: closed source | Production reference only |
| FluidTokens v4 | P2P loans | None | Yes: `lenderAuth` has script variants | P2P offers, not deposit yield |
| Indigo v2 | CDP | None | **No**: `cdpOwner: Maybe<PubKeyHash>` | Exclude (§7) |
| Butane | CDP | None | Yes: `MustWithdrawFrom`/`MustSpendToken` | V2, audit unverified (§7) |

**Two consequences:**
1. Only a few protocols accept a script owner at all, so **every protocol must be allowlisted explicitly**. A "generic DeFi" path would lock funds in protocols like WingRiders.
2. **Minswap's `CancelOrderByOwner` places no constraint on outputs.** Whoever satisfies the canceller decides where the order's funds go. The canceller must therefore be a script *we* control that forces refunds to the vault (§2.2).

## 2. Architecture

### 2.1 Adapters: one audited module per protocol
- An **adapter** is a small, separate validator with a `withdraw` handler, used as a withdraw-zero "forwarding" check. It encodes one protocol's datum rules. The vault core stays generic.
- `ConfigDatum` gains `adapters: List<{adapter: ScriptHash, order_script: ScriptHash}>`. Owners add or remove them at threshold, like any config change.
- `AllowanceDatum` gains `defi: List<AdapterGrant>`. Each grant holds that allowance's limits for one adapter:
  - the allowed pools / LP assets;
  - `max_batcher_fee`, `max_order_ttl`;
  - the allowed order steps.
- **Vault change (agent path):** an output whose payment credential is `Script(h)` is accepted only when:
  - `h` is an `order_script` in the config;
  - the allowance grants that adapter;
  - **the tx withdraws from that adapter** (withdraw-zero).

  All other destination rules stay as they are.
- **The adapter's job:** read the allowance (the single vault input) and its grant, then validate **every** output to its `order_script`, one by one. Section 2.2 gives the Minswap rules.

**Why adapters:**
- **Isolation.** The vault core stays small (about 400 lines) and protocol-agnostic. A protocol bug is contained in one adapter.
- **Audit scope.** Each adapter can be audited, versioned and revoked independently.
- **Cost.** Adapters run once per tx through withdraw-zero, not once per input.

### 2.2 Minswap order rules (the adapter's checks)
For each output to the Minswap order script:
- **Inline datum, decoded as `OrderDatum`.**
- **`canceller = OAMWithdrawScript(adapter)`.** Not `OAMSpendScript(vault)`: that would let *any* tx spending *any* vault UTxO cancel the order and route its funds anywhere.
- **Both `success_receiver` and `refund_receiver` are the vault's canonical address, each with the agreed tag datum.** In slice 1 that is `EODNoDatum`; the tag is introduced in slice 3, §4.
- **`step` is in the grant's allowed steps.** Slice 1 allows only `SwapExactIn{killable: true}`. `Donation`, `PartialSwap`, multi-routing and other-owner steps are refused.
- **`lp_asset` (the pool) is in the grant's pool allowlist.**
- **`max_batcher_fee ≤ grant.max_batcher_fee`.**
- **`expiry_setting_opt = Some(t, tip)`** with `t ≤ tx upper bound + grant.max_order_ttl` and `tip ≤` a small bound. After expiry anyone can refund the order, and only to the vault.
- **No reference script, and no extra tokens beyond the swap input plus fees.**

### 2.3 Where everything lives
| Thing | Location | Role, under existing rules |
|---|---|---|
| In-flight order | Minswap order script, `canceller = adapter` | Not a vault UTxO, but only the adapter (§3) or expiry can move it, and only to the vault |
| Swap proceeds and refunds (batcher outputs) | Vault canonical address, **no vault token** | **Treasury**, owner threshold only. That is the "owner sweep": `OwnerManage` already spends any vault UTxO with a datum or without one (V3). No new path in slice 1. |
| LP tokens, lending receipts (later) | In the **allowance UTxO**, as capped assets | Agent-managed within caps; revocation reclaims them with the allowance |

## 3. Cancellation
**Agent-initiated cancel (slice 2).** The adapter's withdraw handler gains a `Cancel` redeemer. Requirements:
- **The allowance UTxO is a reference input,** identified by its vault token.
- **Its `agent` signed the tx, or the owner threshold signed** (config as reference input). Owners can therefore cancel in-flight orders after a revoke.
- **Every cancelled order's full value goes to the vault canonical address,** minus at most the tx fee paid from the canceller's own key UTxO.
- **No vault UTxO is spent,** so the core vault is untouched by cancels.

The vault still enforces the pause: the adapter refuses `Cancel` by the agent while the config is paused. Owners can still cancel.

**Expired orders.** Minswap's own `CancelExpiredOrderByAnyone` refunds to `refund_receiver` (the vault). Nothing for us to build.

## 4. Positions beyond swaps
- **LP tokens (slice 3):**
  - **Deposit:** the agent places `Deposit`/zap-in orders. The resulting LP tokens arrive at the vault.
  - **Withdraw:** to manage them, the LP tokens must be **in the allowance**. That needs proceeds the agent can *claim*, which means a tag: set `success_receiver_datum = EODInlineDatum(hash(Proceeds{allowance: token_name}))`.
  - **New `AgentClaim` path:** the agent spends its allowance plus tagged orphan UTxOs, and the continuing allowance absorbs them. Two rules:
    - only assets already in the allowance's caps may be absorbed;
    - untagged orphans (treasury) are never claimable.
  - **Withdraw/ZapOut orders** are then capped outflows of the LP token.
  - **Risk to verify first:** whether Minswap's preprod batcher can produce an inline-datum output from only a datum hash in the order. If it can't, LP stays owner-swept.
- **Lending deposits (slice 4).** No protocol has a verified preprod deployment.
  - The only verifiable script-compatible design is Lenfi v1: a bearer LP token and redemption without a signature.
  - Lenfi is Plutus V2 and stale, so it would have to be deployed to preprod ourselves.
  - Same pattern as LP: the receipt token lives in the allowance as a capped asset, redemption outputs pay the vault, and the claim path absorbs them.
- **Revocation returns everything:**
  - The allowance UTxO (holding LP tokens and receipts) is reclaimed as today.
  - In-flight orders are cancelled by owners through the adapter, or expire and refund.
  - Proceeds already at the vault are treasury.
  - Nothing is ever owned by the agent key.

## 5. Cap accounting for positions ("turnover budget")
- **The rule:** placing an order is an outflow. The order value counts against caps, like any spend. Proceeds and refunds that come back **do not** restore cap headroom.
- **Why:** crediting returns would let the agent cycle value. Proving a return came from its own order needs tagging, and that is attack surface.
- **What this makes the cap:** a **turnover** limit, not an exposure limit. An agent that swaps 10 ADA back and forth consumes 10 ADA of cap each time.
- **Escape hatch:** an owner-co-signed rebalance (`CoSignedSpend`) bypasses caps.
- **Price risk:** the cap also bounds price-impact losses. A compromised agent can set `minimum_receive = 1` and lose up to the order value to slippage or a sandwich. Two options:
  - accept it: the loss is bounded by `tx_cap` and `window_cap`;
  - an oracle-based minimum price, using Charli3 or Orcfax as a reference input. That adds a new trust dependency, so it is deferred.

## 6. Validator paths, budgets, new threat edges

### 6.1 Paths
| Path | Change | Budget estimate (to be measured) |
|---|---|---|
| `AgentSpend` | Destination check also accepts approved order-script outputs when the adapter withdrawal is present. Reads one more list from config and allowance. | Currently worst case 35% mem / 20% cpu at max sizes (including fixture overhead). Expect +2–5% for the extra list checks. |
| Adapter `withdraw` (place) | New. Decodes N order datums and checks the rules in §2.2. | ~1–2M mem per order output. With ≤ 3 orders per tx, about 10–20% of the tx limit. **Combined with AgentSpend: target ≤ 60%.** |
| Adapter `withdraw` (cancel) | New. Reference-input allowance, signature, refund outputs. | ~1–2M mem, plus Minswap's own order validator (V2) per cancelled order: unknown, must be measured on preprod. |
| `AgentClaim` (slice 3) | New spend path for tagged orphans. Each orphan input runs the vault validator, so make the orphan check a cheap forwarding check ("claim withdrawal present"). | ~0.3M mem per orphan plus one claim check; cap orphans per tx at about 10 |
| Adapter `publish` | Stake registration of the adapter (needed for withdraw-zero). Deregistration is owner-threshold only. | Small |
| Config / allowance datums | New fields, validated at write time (config) or read time (allowance, deny by default) | Small |

### 6.2 New threat-model edges (each needs a test or a written out-of-scope reason)
1. **Order names the attacker** as canceller, success receiver or refund receiver → adapter field checks.
2. **Unconstrained Minswap cancel outputs** → the canceller must be the adapter, which forces refunds to the vault (§2.2, §3).
3. **Fake or manipulated pool** (an order against a pool the agent created) → per-allowance pool allowlist.
4. **`minimum_receive` ≈ 0 / sandwich** → bounded by caps. An oracle floor is optional (§5).
5. **Inflated `max_batcher_fee`** → grant cap, and it is counted in outflow.
6. **Missing expiry, or "never killable" orders that strand funds** → expiry required, killable required.
7. **Disallowed steps:** `Donation` (gifts funds to the pool), `PartialSwap` continuations, multi-routing → step allowlist.
8. **Datum by hash on the order, or a reference script on the order output** → refused.
9. **Proceeds and refunds become treasury** → the agent can't claim untagged UTxOs. Owner sweep only, until slice 3's tagged claim.
10. **The agent claims the treasury or another allowance's proceeds** → claim requires `Proceeds{allowance: own_token}`, and absorbed assets ⊆ own caps. A forged tag can only *donate*.
11. **Adapter stake credential (de)registration griefing** → the adapter's `publish` handler is owner-threshold only. The adapter holds no funds, so no rewards are at stake. **This re-introduces edges I1/I2, scoped to adapters.**
12. **Adapter swap or upgrade** → owner-threshold config change. Adapters are trusted code: an audit per adapter.
13. **Protocol upgrade changes `order_script`** → the pinned hash in config stops matching, so there are no new orders until owners update it. Fail closed.
14. **Cross-agent cancel griefing** → cancel requires that allowance's agent or the owners. It never uses `OAMSpendScript(vault)`.
15. **In-flight orders at pause or revoke** → placement is blocked while paused. Owners can cancel. Expiry refunds anyway.
16. **Multiple orders in one tx (double satisfaction)** → the adapter validates each order output independently against the single allowance input. Outflow is still `in − continuing`.
17. **Plutus V2 protocol scripts alongside our V3 scripts in one tx** → must be tested on preprod. PV11 revised V1/V2 reference-input rules; check that Minswap's V2 order script tolerates our reference inputs.
18. **Batcher censorship or delay** → an availability issue, not a safety issue. Expiry plus anyone-can-refund bounds it.
19. **A malformed order datum locks funds forever in the protocol's script** (observed, §11) → the adapter decodes with the exact protocol schema, and the SDK's order encodings are tested against the protocol's own validator in CI before submission.

## 7. CDPs: analysis only. Last, if at all. Not in the build sequence.
- **Script ownership.**
  - **Indigo** stores `cdpOwner` as a raw `PubKeyHash`. A vault script hash placed there can never sign, so the CDP would be **locked permanently**. Its stability-pool account has the same `pkh` owner.
  - **Butane** supports script owners (`MustWithdrawFrom`/`MustSpendToken`). But it is Plutus V2, has no preprod deployment, and its audit is unverified.
  - **Djed** is a pooled reserve, not a per-user CDP.
- **Liquidation risk to the vault.** Collateral can be seized whenever the collateral ratio falls below the protocol minimum. That is driven by oracle prices, **with no tx from the agent at all**. The loss is up to the posted collateral minus any leftover (Butane `LeftoversDatum`; Indigo `Frozen` state with `cdpOwner: null`). It happens at market speed, not at the speed of the agent's cap.
- **Debt the vault would owe.**
  - Minted synthetics (iAssets) are a **liability**, and fees and interest accrue.
  - To recover collateral, the vault must repay the debt. If the agent minted and then spent or sold the synthetic, the owners must buy it back.
  - So "revoke and get everything back" **no longer holds** without repayment, and repayment cost depends on the market.
- **Position-receipt handling.**
  - Indigo: there is no bearer receipt; ownership is the `pkh` datum field.
  - Butane: ownership can be a CDP NFT (`MustSpendToken`) held in the allowance. Leftovers after liquidation must be claimable to the vault through the same adapter.
- **Is this a different risk class from a capped outflow? Yes.**
  - A capped outflow has a loss known and bounded *at signing* (≤ the cap).
  - A CDP is a leveraged, path-dependent liability. Loss can occur later with no agent action, and it can exceed what the outflow caps measure: minting creates an obligation, not an outflow.
  - Bounding it would need a different policy model:
    - maximum debt;
    - a minimum collateral-ratio buffer checked against an oracle;
    - forced deleveraging;
    - owner co-signing to open.

**Recommendation: EXCLUDE.** Revisit only if a CDP protocol is both:
- **script-owner capable** (Butane-style), and
- **live on preprod with a current audit.**

Even then, opening a CDP should be **owner-co-signed** (`CoSignedSpend`), never autonomous.

## 8. Sequencing and effort
| Slice | Scope | Done when | Effort |
|---|---|---|---|
| **1. Minswap swaps, owner sweep** | Minswap adapter (place only); config and allowance datum fields; vault agent-path change; `CoSignedSpend` refuses script destinations; adapter stake registration; SDK order builder (Minswap datum encoding); pool discovery on preprod; "turnover budget" rename | Unit, property and mutation tests for §2.2 and edges 1, 3–8, 11–13, 16. Attack replay on preprod. Demo: the agent swaps ADA→token, proceeds land as treasury, owners sweep. **Budget measured on preprod, plus the audit-scope diff.** | **12–18 days** |
| 2. Cancel and treasury-funded orders | Adapter `Cancel` (agent or owners), pause interaction, revoke flow cancels in-flight orders. Treasury-funded orders (owner-threshold, owner-only cancel). | Edges 2, 14, 15 replayed on preprod. Demo: the agent cancels; owners cancel after a revoke; an expired order refunds to the vault; owners place and cancel a treasury order. **Budget on preprod, plus the audit-scope diff.** | **6–8 days** |
| 3. LP positions | Deposit, withdraw and zap-out steps; proceeds tagging; `AgentClaim` as a **separate tx that pays nothing out**. LP caps must be expressible in the underlying asset; otherwise owner co-sign. | Edges 9, 10, claim-budget tests, and a test that a claim-plus-payment tx fails. **Gate:** confirm the preprod batcher emits inline-datum outputs from a hash. **Budget on preprod, plus the audit-scope diff.** | **10–14 days** |
| ~~4. Lending~~ | **Cut.** Written gate: a lending protocol with a **live preprod deployment** and **verified script-compatible redemption**. No self-deployed protocols. Re-evaluate when that gate is met. | n/a | n/a |
| CDP | n/a | Excluded (§7) | n/a |

Every slice also needs:
- a new audit scope (the adapter, plus the vault diff);
- the budget re-measured on preprod.

## 9. Sources (commits read)
- **Minswap V2:**
  - `github.com/minswap/minswap-dex-v2` @c3293ad (v2.0.0): `lib/amm_dex_v2/types.ak`, `validators/order_validator.ak`, `lib/amm_dex_v2/utils.ak` (`authorize_order_license`), `order_validation.ak`.
  - Preprod: `deployed/preprod/script.json`. Order address `addr_test1wrdf2f2x8pq3wwk3yv936ksmt59rz94mm66yzge8zj9pk7s0kjph3`.
  - Audits: `audit-report/{certik,anastasia-labs}/`.
- **SundaeSwap V3:** `github.com/SundaeSwap-finance/sundae-contracts` @be33466 (`validators/order.ak`, `lib/types/order.ak`).
- **WingRiders V2:** `github.com/WingRiders/dex-v2-contracts` @280a9e8 (`src/DEX/Types/Request.hs`, `src/Plutarch/Util.hs:622`).
- **Splash:**
  - `github.com/splashprotocol/splash-core` @a185ee8. Note the 2026-09-13 stable-pool incident notice.
  - Deployments: `splash-offchain-multiplatform` @f231264 `bloom-cardano-agent/resources/preprod.deployment.json`.
- **Lenfi:** `github.com/lenfiLabs/lenfi-smart-contracts` @882be2f (`validators/pool.ak`, `lib/aada/types/order.ak`).
- **FluidTokens:** `github.com/FluidTokens/ft-cardano-loans-v4` @fec809e.
- **Liqwid:** closed source. Docs: liqwid-labs.gitbook.io.
- **Indigo:**
  - Validators not public. Schema from `github.com/IndigoProtocol/sdk` @ee37c96 (`src/contracts/cdp/types-new.ts`).
  - Compiled UPLC: `indigo-upgrade-details-v2`.
- **Butane:** `github.com/butaneprotocol/butane-contracts` @b8cbcdd (`lib/butane/types.ak`, `utils.ak:326-365`).

## 10. Open verifications before slice 1 (no code until settled)
1. **Minswap preprod batcher list.** Read the GlobalSetting datum (the `MSGS` NFT) on preprod and confirm batchers are active, i.e. orders are actually executed.
2. **Preprod pools for the pair.** Which ADA↔token pools exist on the preprod Minswap V2 deployment, and with what liquidity?
3. **Minswap's V2 order script alongside our V3 scripts and reference inputs under PV11.** Ledger rules, plus an empirical check on preprod. Results go in §11.

## 11. Verification results (preprod, 2026-10-05)
**1. Batchers: settled, positive with a caveat.**
- The GlobalSetting datum lists 3 batcher keys.
- Execution is **sporadic**, in bursts every few days. During a burst, orders executed within minutes.
- 270 stale orders sit unexecuted at the order address.
- **Our order A** (5 tADA → NACRE, receiver = our V3 vault script address, `EODNoDatum`) was executed in `cfb2e130…`. The vault received 2 tADA + 9,917,527,345 NACRE **with no datum**.
- A third-party order with a **script canceller (`OAMWithdrawScript`) and a script receiver** was also executed (`c82c8c16…`). Script-wallet orders are a supported path.
- **Caveat:** demos depend on batcher uptime. An expiry plus anyone-can-refund bounds stuck funds.

**2. Pools: settled.**
- 330 Minswap V2 pools on preprod.
- Deepest: ADA ↔ NACRE, about 381k ADA, LP asset `d6aae205…e5358cee…6fd3`.
- A 5–10 tADA swap has negligible price impact.

**3. V2 order script with our V3 scripts under PV11: settled.**
- **Ledger:**
  - PV11 lifts the input/reference-input disjointness rule (`disjointRefInputs` is enforced only for PV 9–10).
  - "Reference inputs not supported" applies only to Plutus V1.
  - V2 contexts can't represent Conway-only fields, so adapter stake registration must be a separate tx.
- **Empirical:** order C was cancelled with `CancelOrderByOwner` in `05b27551…`, with reference inputs = Minswap's V2 order script, our V3 config UTxO, and our V3 reference script. It was accepted.

**Finding (new hard requirement for slice 1).**
- Two orders I placed with a wrong encoding of `expiry_setting_opt: Option<(Int, Int)>` (I encoded the tuple as a constructor; Aiken encodes tuples as **lists**) are **permanently stuck**. Every Minswap path decodes the datum first, so they can't be executed, cancelled or expired. That's about 18 tADA, testnet only.
- **Requirements:**
  - The adapter must decode every order with the protocol's **exact** schema.
  - Every order shape the SDK can produce must be tested against **Minswap's own validator** in CI (local UPLC evaluation of their compiled script), before any tx is submitted.
- Added as threat edge 19.
