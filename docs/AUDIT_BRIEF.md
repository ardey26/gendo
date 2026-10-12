# Audit brief: Gendo (`mvp-v0.1` + changes)

**Tag:** `mvp-v0.1` (branch `mvp`). The project was then named Noether; it is now Gendo. §1a lists what changed after the tag.

**Status:** an unaudited MVP on Cardano preprod. This brief is for the auditor: it gives the scope, the claims to break, the evidence behind them, and where the design is new.

## 1. Scope

**In scope:** the on-chain code (Plutus V3, Aiken).

| File | Role |
|---|---|
| `onchain/validators/vault.ak` | Multi-validator (`spend` + `mint`), parameterised by a seed `OutputReference`. Its bottom half is wiring tests. |
| `onchain/validators/ref_holder.ak` | Always-fail; holds the reference script |
| `onchain/lib/vault/allowance.ak` | Agent path, co-signed path, allowance mint and burn, read-time datum validation |
| `onchain/lib/vault/owner.ak` | One-shot config init, `OwnerManage` (config updates, treasury, reclaim) |
| `onchain/lib/vault/config.ak` | Config lookup, canonical address, the no-reference-script check |
| `onchain/lib/vault/owners.ak`, `multisig.ak` | Config validity, threshold counting |
| `onchain/lib/vault/types.ak` | Datums, redeemers, size bounds |

About 400 lines of production Aiken.

**Secondary scope (off-chain, not security-critical for funds):**
- `sdk/src/idempotency.ts` and `pay.ts`: these prevent double payment by honest integrators.
- `sdk/src/signer/`: rate and budget limits the chain can't express.

**Build:** compiler and dependency versions are pinned. `scripts/aiken.sh build` fetches Aiken v1.1.24, checks its sha256, and writes `onchain/plutus.json`. The unparameterised hashes:

| Validator | Build | Hash | Size |
|---|---|---|---|
| vault | `mvp-v0.1` | `36c2f4de15e65ba726f84ba18144cffe5fbe9d6033c0f4bf6b37bbc8` | 5,967 B |
| vault | **current** (after the `is_well_formed` change in §1a) | `eeb761e96642d5f864ab0c03b1beac126a2ed89b5136ae0a952d499f` | 5,977 B |
| ref_holder | both | `22c9a103ed3f2fa97c982d76d6e2af50c5d54ac306983b196c8fcdab` | 17 B |

Each vault instance applies its seed `OutputReference`. Note that the v3 → v4 stdlib migration produced **byte-identical** validators, and so did the rename to Gendo (rebuilt and compared before any code change).

## 1a. Changes since `mvp-v0.1`
**On-chain (changes the vault hash):**
- `is_well_formed` now requires `0 < tx_cap ≤ window_cap` for every cap; before, it only required both to be ≥ 0. This matches the datum spec in `docs/PLAN.md` §2.2.
- **Behaviour change:** a zero cap used to deny that one asset and leave the rest of the allowance usable. It now makes the whole datum malformed, so every agent-signed spend fails and owners reclaim. To forbid an asset, leave it out of `caps`. The SDK refuses such a grant up front.
- New tests: unit boundaries (`tx_cap = 1`, `tx_cap = window_cap`, `tx_cap = window_cap + 1`, `tx_cap = 0`), a new malformed-datum property case, and 4 new mutations on both bounds.
- **Test gap closed:** the `max_fee >= 0` guard was killed only when a property test happened to hit a 1-in-27 branch, so a full mutation run could miss it (one did). Two unit tests now check it directly, with 2 new boundary mutations.

**Off-chain (secondary scope):**
- The signer pins the one allowance it serves. The continuing output must carry `allowanceUnit`; with one input and no mint, that pins the input.
- The signer keeps a daily budget **per asset**, deny by default: an asset with no limit can't leave. It used to count lovelace only.
- The signer requires exactly one input on the co-signed path too.
- `describeTx` names a redeemer as the vault's only when its target is proven to be the vault: a mint under the vault policy, or a spent input whose supplied address is at the vault script. The intent record is read only from that redeemer.
- **Bug fixed:** asset units were built with `to_cbor_hex().slice(2)`, which keeps a length byte for names of 24+ bytes, so every 28-byte allowance token showed with a stray `1c` prefix.

**Pins:**
- Aiken compiler v1.1.24.
- `aiken-lang/stdlib` v4.0.0.
- `aiken-lang/fuzz` v3.0.0 (tests only).
- `anastasia-labs/aiken-design-patterns` v1.9.0. Only `validity_range_normalization` is used, and it is byte-identical to v1.8.0.

## 2. Trust model
- **Owners** (m-of-n, at most 10) are trusted *at threshold*. A single owner is not trusted.
- **The agent key is assumed compromised.** The attacker builds arbitrary transactions.
- **Providers and indexers are untrusted for safety.** They may be stale or inconsistent; that can affect liveness and the off-chain idempotency logic, never on-chain limits.
- **Anyone can send UTxOs, with any datum or tokens, to the vault address.**

## 3. Claims to break (invariants)
1. An agent-only tx moves, per asset and per fixed window, at most `window_cap`, and per tx at most `tx_cap`. "Moves" means everything that leaves the allowance UTxO, **including the fee**.
2. An agent-only tx pays only allowlisted addresses, matched on the full address, stake part included.
3. An agent-only tx touches only its own allowance UTxO. It mints nothing, burns nothing, and carries no certificates, withdrawals, votes, proposals or donation.
4. The continuing allowance state is exactly what the validator computes; the agent can't choose it.
5. Nothing works without the owner threshold, from the *current* config, to:
   - mint an allowance token;
   - change the config;
   - move treasury funds;
   - edit or reclaim an allowance.
6. Reclaim works on any UTxO holding an allowance token, whatever its datum.
7. While `paused`, no path that needs an agent signature succeeds.
8. The config NFT is unique, can never be burned or re-minted, and stays at the canonical address with a valid datum.
9. The vault's identity (address and policy) is independent of the owner set.

## 4. Threat model: each edge, its resolution, its evidence

**Columns:**
- **Layer:** OC = on-chain validator, LG = ledger rule, OFF = off-chain.
- **Unit:** Aiken tests in `onchain/lib/vault/*.test.ak`.
- **Node:** raw-tx replays in `sdk/test/yaci/adversarial.test.ts`, run on two targets:
  - **devnet:** cardano-node 10.5.0, PV10;
  - **preprod:** the real network, PV11.

### Value
| Edge | Resolution | Layer | Unit | Node |
|---|---|---|---|---|
| Fee set absurdly high | The fee is part of `in − continuing`, so it counts against the lovelace cap. `fee ≤ max_fee` is also checked. | OC | `v1_*` | V1 |
| Change or dust to the agent's address | There is no separate change: the whole outflow counts. The agent's address isn't allowlisted. | OC | `v2_*` | V2 |
| Mint or burn inside an agent spend | `mint == 0`. Certificates, withdrawals and donation are also refused. | OC | `v3_*`, `value_*` | V3 (mint), V3 (certificate) |
| Non-whitelisted tokens riding along | Every asset that leaves must be capped | OC | `v4_*` | V4 |

### UTxO structure
| Edge | Resolution | Layer | Unit | Node |
|---|---|---|---|---|
| Double satisfaction | The agent tx has exactly one input. On owner paths, allowances are identified by a unique token. | OC | `u1_*` | U1 ×2 |
| Splitting to multiply the cap | Token quantity is 1, there is exactly one vault output, and duplicate names are impossible: names derive from spent inputs and mint quantity is exactly 1. | OC | `u2_*`, `create_quantity_two_split_across_outputs` | U2 ×2 |
| Fake allowance UTxOs | The role comes from the token, never from the datum | OC | `u3_*` | U3 |
| Bloated continuing output (junk or a big datum) | Continuing ⊆ input. The datum must equal the computed one. Reference scripts are refused. | OC | `u4_*` | U4 ×3 |
| Datum by hash | An inline datum is required on created and continuing outputs | OC | `u5_*`, `create_output_datum_hash` | U5 |
| Malformed datum written by the agent | The agent can't write the datum. The read is deny-by-default (`is_well_formed`). Reclaim never decodes. | OC | 3-layer property tests in `allowance_props.test.ak` | U6 |

### Time
| Edge | Resolution | Layer | Unit | Node |
|---|---|---|---|---|
| Unbounded validity bound | Only a closed range is accepted | OC | `t1_*` | T1 ×2 |
| Straddling or stretched window | The whole range must sit inside one window, with width ≤ `max_tx_validity_ms` | OC | `t2_*`, `prop_range_*` | T2 ×2 |
| Inclusive/exclusive off-by-one | Explicit normalisation (ADP). Tests cover every edge ms. | OC | `t3_*` | n/a (unit) |
| Period 0, future start, overflow | `period > 0`; `lower ≥ window_start`; Plutus integers are unbounded | OC | `t4_*`, `huge_caps_no_overflow` | n/a (unit) |

### Destinations and config
| Edge | Resolution | Layer | Unit | Node |
|---|---|---|---|---|
| Swapped stake credential | Exact full-address equality | OC | `d1_*` | D1 ×3 |
| Membership proofs | Not applicable: an inline allowlist of at most 10 entries, read from the authenticated datum. An empty list denies everything. | OC | `d2_*`, property tests | n/a |
| Allowlist or config too big for the budget | Size bounds. Worst case is 35% mem / 20% cpu (`scripts/budget.sh`). | OC | `bench_*` | n/a |
| Forged or stale config | One-shot NFT at the canonical address. A spent reference input can't be referenced. | OC + LG | `d4_*`, `treasury_spend_fails_with_forged_config_policy` | D4 forged, D4 stale |
| Invalid owner sets | `is_valid_config` at init and at every update | OC | unit + property in `owners.test.ak` | n/a (unit) |
| Agent key is also an owner key | Checked against the live config on every agent and co-signed spend | OC | `d6_*`, `cosign_agent_is_owner` | D6 |

### Revocation
| Edge | Resolution | Layer | Evidence |
|---|---|---|---|
| Agent front-runs a revocation | Not preventable. The loss is bounded (B3). Guidance: pause first. | design | §6 |
| Revoke and spend in the same block | Both consume one UTxO, so exactly one lands | LG | Node: R2 |

### Infra
| Edge | Resolution | Layer | Evidence |
|---|---|---|---|
| Stake credential deregistered by anyone | The vault address has no stake credential and uses no withdraw-zero | design | address construction in `config.canonical_address` |
| Rewards stranded on the vault's credential | No stake credential, so no rewards accrue | design | as above |
| Reference-script UTxO removed | Parked at always-fail `ref_holder`; the SDK falls back to an inline script | OC | Node: I3 |
| Allowance used as collateral | Collateral must be key-locked | LG | Node: I4 |
| Network id mix-up | The ledger enforces `WrongNetwork`. The SDK refuses mainnet and checks the provider's network magic. | LG + OFF | Node: I5 |
| Provider inconsistency | Fate-checked submission. Intent-id idempotency via a durable journal plus a UTxO-lineage chain scan. Settled, cross-checked reads. Validity anchored at the chain tip. | OFF | `sdk/test/yaci/idempotency.test.ts` (4 scenarios), `sdk/test/unit/idempotency.test.ts` |

### Off-chain
| Edge | Resolution | Layer | Evidence |
|---|---|---|---|
| Hot key in the LLM process | A separate signer daemon (Unix socket, mode 0600) is the only key holder | OFF | emulator: signer daemon test |
| Prompt injection driving max spends | On-chain caps bound it. The signer adds rate and budget limits. | OC + OFF | unit: signer policy tests |
| Pre-signed txs held back | TTL ≤ `max_tx_validity_ms`, so the tx can never be *included* after it (see B2 for the mempool nuance). Any intervening spend also kills it. | OC + LG | Node: O3 |

## 5. Reused patterns and where they are used

| Pattern | Source (pin; audit status) | Used in | Deviation from source |
|---|---|---|---|
| Validity-range normalisation | Anastasia `aiken-design-patterns` v1.9.0 `validity_range_normalization`. Dependency, unmodified; **no published audit**. | `allowance.agent_spend`: only `ClosedRange` is accepted | none |
| One-shot NFT parameterised by OutputReference | Sundae `treasury-contracts` `validators/oneshot.ak`. Audited by TxPipe and MLabs at stdlib v2; ported. | `owner.init_config` | Hardened: pins the token name, quantity 1, and a single canonical output with a valid inline config datum, ADA + NFT only and no reference script |
| NFT-authenticated reference-input registry | Sundae `utilities.find_script_hash_registry` (ported) | `config.find_config` | Also checks the canonical address, because our config lives at a spendable address rather than an always-fail one. Falls back to spent inputs when the config itself is being updated. |
| No reference scripts on outputs | Sundae `utilities.ensure_no_ref_scripts` (ported) | `config.no_ref_scripts` ← `agent_spend` | Applied to the agent path only |
| Malformed-datum escape hatch | Sundae `logic/vendor/malformed.ak`; the motivation is Sundae audit finding 3.14 | `owner.owner_manage`, which never decodes an allowance datum | Owner threshold instead of a malformed-only sweep |
| Threshold multisig | aicone `sundae/multisig.satisfied` @504e104 (the revision pinned by the audited treasury). Copied subset. | `multisig.satisfied` ← `owners.threshold_met` | Only `Signature` and `AtLeast`. Duplicate owners are rejected by `is_valid_config`, because `AtLeast` counts duplicates twice. |
| Double-satisfaction guard | Sundae `ensure_compliant_scripts`; Plutonomicon | `agent_spend`: `expect [_] = tx.inputs` | Strengthened from "only known scripts" to "exactly one input" |
| Validity-interval length bound | Sundae `utilities.interval_length_at_most` (idea) | `agent_spend`: `upper − lower + 1 ≤ max_tx_validity_ms` | Computed on the normalised range |

**Ported code is not audited code.** The audits cover Sundae's composition at stdlib v2, not this composition.

## 6. Documented bounds
| # | Bound | Statement |
|---|---|---|
| B1 | **2× window burst** | Each *fixed* window `[ws + kP, ws + (k+1)P)` sees at most `window_cap` per asset, and each tx at most `tx_cap`. **Any interval of length P can see up to 2 × `window_cap`**: the cap spent at the end of window k, then again at the start of k+1. Equivalently, any interval of length `n·P` sees at most `(n+1)·window_cap`. A sliding-window counter is planned for v2. |
| B2 | **max_skew = `max_tx_validity_ms`** (config, owner-set) | A spend is attributed to the window containing its *whole* validity range, and inclusion happens at a slot inside that range. So window attribution is exact: zero skew at window granularity. The bound is on time between signing and inclusion: a signed tx is includable for at most `max_tx_validity_ms` (≤ 36 h horizon on preprod; the demo uses 10 min). It also bounds how far apart "when the agent decided" and "when the chain counted it" can be. Details below the table. |
| B3 | **Front-run and pause latency** | Revoke and pause take effect at inclusion. Before that, loss is at most `window_cap − spent` per asset in the current window, plus one more `window_cap` if a boundary passes before the pause lands (B1). Each tx is ≤ `tx_cap`, and only one spend per allowance fits per block. |
| B4 | **Throughput** | One agent spend per allowance per block (sequential UTxO) |
| B5 | **Budget** | Max-size paths (10 owners, 10 destinations, 5 assets, 10 payment outputs) cost ≤ 35% mem and ≤ 20% cpu of the per-tx limit, measured including test-tx construction |
| B6 | **Sizes** | Owners ≤ 10, destinations ≤ 10, capped assets ≤ 5 |
| B7 | **Fee** | ≤ `max_fee` per tx, and inside the lovelace window and tx caps |
| B8 | **Min-ADA** | The continuing output keeps min-ADA, so an allowance's lovelace can't be fully drained by the agent. Owners reclaim the remainder. |

**B2 in detail:**
- **Granularity.** Bounds are slot-aligned: 1 s slots, so `ms` fields are effectively at second resolution.
- **SDK lower bound.** The SDK sets the lower bound 60 s in the past, which tolerates agent clock skew up to about 60 s.
- **The mempool nuance**, observed on preprod. A mempool checks validity against the *tip's* slot. With about 20-second blocks, it can *accept* a tx shortly after its TTL by wall clock. Such a tx can never be *included*: the ledger rejects it at the next block. Test O3 asserts non-inclusion on preprod and outright rejection on the 1-second devnet.

## 7. Evidence summary

**Observed on preprod, and fixed:**
- **Mempool tip lag.** The mempool judged validity against a tip 58–74 s behind the wall clock, so lower bounds near "now" were rejected. Validity is now anchored at the tip.
- **Asset-index lag paid an intent twice.** An earlier chain scan used the per-asset history index, which missed a just-settled payment. With the journal deliberately deleted, a test intent was paid twice. The scan now follows the allowance's UTxO lineage, and the journal is documented as required.
| Evidence | Count | Command |
|---|---|---|
| Aiken unit, adversarial and property tests | 188 (174 unit/adversarial, 14 property) | `scripts/aiken.sh check` |
| Mutation suite: every guard must be killed | 78/78 killed | `scripts/mutate-all.sh` |
| Budget at max sizes | 35% / 20% worst case | `scripts/budget.sh` |
| SDK unit + emulator (honest flows, signer daemon, fate logic, lineage scan) | 53 | `cd sdk && npx vitest run test/unit test/emulator` |
| Raw-tx attack replay, devnet (PV10) | 34/34 rejected for the expected reason | `scripts/devnet.sh up && cd sdk && npx vitest run test/yaci` |
| Double-payment scenarios, devnet | 6/6 (4 `payOnce`, 2 signer dedupe) | same |
| Raw-tx attack replay, **preprod (PV11)** | 34/34 rejected for the expected reason | `ADV_TARGET=preprod BLOCKFROST_PROJECT_ID=… FUNDER_KEY=… npx vitest run test/yaci` |
| Double-payment scenarios, **preprod (PV11)** | 6/6, including lost-journal recovery via the lineage scan | same, with `ADV_TARGET=preprod` |
| CLI smoke (every flow) | 19 checks | `cli/test/smoke.sh` |
| Preprod demo | 16 txs + 11 refusals, including two LLM agent runs | `demo/RESULTS.md` |

**Not yet re-run after §1a:** the devnet and preprod suites, the CLI smoke test and the demo. Their counts above come from the build before §1a; the Aiken, mutation, budget and SDK counts are from the current build.

How the attack replay works:
- The attacker builder (`sdk/test/yaci/attacker.ts`) skips every SDK guard. A blind evaluator returns fixed ex-units, so **no script runs before the node**.
- Every case changes one aspect of an honest spend, and a baseline test proves the honest spend is accepted.
- Rejections are asserted *by reason*: a script failure for OC edges, the named ledger rule for LG edges.

## 8. Where to focus
1. **The outflow-accounting core.** In `agent_spend`, "exactly one input + zero mint + no certificates/withdrawals/donation/proposals/votes ⇒ `in − continuing` = total outflow including the fee". Check this against every Conway tx field.
2. **Window arithmetic and normalisation:**
   - floor division with `lower ≥ window_start`;
   - roll-over (`k > 0` resets `spent`);
   - `upper < window_start + P`;
   - width `upper − lower + 1`;
   - `upper < expires_at`.
3. **`is_well_formed`.** Check that no field value reads as more permissive than intended. Caps must satisfy `0 < tx_cap ≤ window_cap` (§1a).
4. **`find_config`.** It takes the first input holding the NFT, searching reference inputs then inputs. The NFT is unique and always at the canonical address with a valid datum, by induction over `init_config` and `owner_manage`. Look for a path that breaks the induction.
5. **`manage_allowances`.** Names derive from spent inputs, quantity is ±1, the output is canonical and holds a single token, and the config NFT is untouchable.
6. **`OwnerManage` is intentionally unconstrained beyond the threshold.** Check that no redeemer confusion or role confusion reaches it without the threshold.
7. **Datum equality.** `continuing.datum == InlineDatum(expected)` compares `Data` structurally. Confirm no encoding variance matters.

## 9. Known limitations (for context)
- **The 2× burst (B1)** is accepted by design.
- **Intent records are commitments only.** Plutus can't read metadata; the 32-byte hash is enforced, the content is off-chain.
- **Disjointness is checked at spend.** Owner/agent disjointness is enforced at spend time; a rotation can't scan all allowances.
- **Off-chain idempotency** depends on a durable operator journal plus a chain scan of the allowance's recent txs. See the README's [integrator guidance](../README.md#integrator-guidance-paying-exactly-once).
- **No KMS/HSM.** The signer's keys live in local files. Its rate counters, per-asset budgets and intent-dedupe table persist in a local JSON file.
