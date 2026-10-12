# Gendo: Architecture and Plan

Gendo (formerly Noether) gives AI agents budgeted on-chain accounts. This is the architecture doc; §9 logs what was built.

Status: approved 2026-10-05 with the decisions in §0. M0 spike in progress.

## 0. Decisions (from review)
- **Windows:** fixed windows plus a **per-tx cap** per asset. Documented bound: any interval of length `period` sees at most 2× the window cap. A sliding-window counter is v2.
- **Destinations:** they pin the **exact full address** (payment + stake part, including the no-stake case).
- **Pause is literal:** while paused, every tx path that needs an agent signature fails. That covers `AgentSpend` and `CoSignedSpend`. Owner-only txs still work, and unpausing needs the owner threshold.
- **M0:** 2-day timebox. The agent path is a hard requirement: fully manual input selection and explicit collateral, with no automatic coin selection. If Lucid Evolution can't do both, we use Blaze.
- **Allowance datum validation happens at read time** (accepted with conditions). Every field is deny-by-default:
  - An empty allowlist, a non-key destination, or a zero or missing lovelace cap denies.
  - Negative caps, negative or wrong-length `spent`, period ≤ 0, expiry not after window start, an expiry already past, a negative max fee, a bad agent key, or an unparseable datum all deny.
  - The input datum is fully validated on **every** agent-signed spend, co-signed included.
  - Property tests run in three layers: `is_well_formed` rejects, agent spend fails, owner reclaim succeeds.
  - Config validation stays on-chain at write time.
- **stdlib:** v3.1.0 + Anastasia aiken-design-patterns v1.8.0 (compiler v1.1.23, fuzz v2.2.0). The v4 migration is a milestone before audit (M6).

Research date: 2026-10-05. The sources are listed in §8.

## 1. Stack

| Layer | Choice | Why | Risk |
|---|---|---|---|
| On-chain | Aiken compiler v1.1.23, stdlib v3.1.0, fuzz v2.2.0, ADP v1.8.0, Plutus V3. Versions are pinned exactly. | These match ADP v1.8.0. Sundae treasury-contracts (the only audited reference) is on stdlib v2.2.0, so its patterns are copied and ported by hand. | The ported code is no longer the audited code. See §7. |
| Ledger | Conway, PV11 (preprod and mainnet) | Current era | None |
| Off-chain | TypeScript with Lucid Evolution 0.6.5. **This choice is decided by the M0 spike.** | `partialSign` + `assemble` cover the co-sign flow. It has an in-process emulator and the widest provider set. | It cannot choose the collateral UTxO and its coin selection fights a single-input tx. Fallback: Blaze, which has a pluggable coin selector and explicit collateral. |
| Provider | Blockfrost (preprod) as the primary. Koios as the cross-check. | Lucid supports both | Indexer lag. See edge I6. |
| Ledger-real tests | Yaci DevKit (Docker; daemon 28.4 is running locally) | It runs a real cardano-node, so ledger rules apply. The in-process emulators do not cover those rules. | Beta software |
| Runtime | Node 22 or newer (`engines` in `sdk/package.json`) | Stability | None |

## 2. Architecture

### 2.1 One validator, one address, one policy

There is a single Aiken multi-validator `vault`. It is parameterized only by a seed `OutputReference`, so its hash is the vault identity.
- **Spend address:** an enterprise address (payment = vault script, **no stake credential**).
- **Mint policy:** the same hash. It mints the config NFT and the allowance state tokens.
- **No withdraw or publish handlers.** A V3 validator with no handler for a purpose rejects it by default.

Rotating owners changes only the config datum. It never changes the script parameter, so **the address and identity never change**.

Each UTxO at the address gets its role from the **vault tokens in its own value**. The datum never decides the role, because a datum can be corrupted.

| UTxO | Holds | Who can spend |
|---|---|---|
| Config | `config` NFT (one-shot) + inline `ConfigDatum` | Owner threshold. The NFT must be re-created at the canonical address with a valid datum. |
| Allowance | 1 allowance token (unique name) + inline `AllowanceDatum` + lovelace + whitelisted assets | The agent alone (within limits), agent + owner threshold (over-limit), or the owner threshold (edit or reclaim) |
| Treasury | Anything without a vault token | Owner threshold only |
| Planted junk | No vault token, so it is treated as treasury | Owners only. The agent path fails because there is no token. |

### 2.2 Datums

```
ConfigDatum {
  owners: List<VerificationKeyHash>,   // 1..=MAX_OWNERS (10), no duplicates
  threshold: Int,                      // 1..=len(owners)
  paused: Bool,
  max_tx_validity_ms: Int,             // limits pre-signed tx shelf life
}

AllowanceDatum {
  agent: VerificationKeyHash,          // must not be in config.owners
  destinations: List<Destination>,     // 1..=MAX_DEST (10)
  caps: List<AssetCap>,                // lovelace ("","") is required; 1..=MAX_ASSETS (5)
  spent: List<Int>,                    // parallel to caps, the current window
  window_start: Int, period_ms: Int,   // period_ms > 0
  expires_at: Int,
  max_fee: Int,
}
AssetCap { policy: PolicyId, name: AssetName, window_cap: Int, tx_cap: Int }  // 0 < tx_cap <= window_cap
Destination = Address   // exact equality, including the stake part (None included); payment must be VerificationKey
```

### 2.3 Redeemers (spend)
- `AgentSpend { intent_hash: ByteArray }` is the autonomous path.
- `CoSignedSpend` is the over-limit path. It needs the agent signature and the owner threshold in one tx.
- `OwnerManage` covers edit, reclaim and treasury moves. It needs the owner threshold only.

Mint redeemers: `InitConfig` (one-shot), `ManageAllowances` (threshold; mint and burn).

### 2.4 Agent spend rules (the core check)
Every rule below is checked on-chain:
1. **The tx has exactly one input**, the allowance UTxO. The agent cannot add inputs, cannot touch the treasury, cannot touch other allowances, and double satisfaction is impossible. Collateral is a separate field, and the ledger requires it to be key-locked.
2. Mint, withdrawals, certificates, votes, proposals and treasury donation are all empty.
3. **spent_this_tx = input.value − continuing.value**, computed per asset. With one input and no mint, this delta counts every payment, all change and the fee. Outputs are never added up.

   **Why this is exact: a conservation law.** The ledger conserves value in every tx: inputs + mint + withdrawals + deposit refunds = outputs + fee + deposits + donation. (The project's first name, Noether, came from Noether's theorem, which ties conservation laws to symmetries.) Rule 2 pins every term except inputs, outputs and the fee to zero, and rule 1 leaves exactly one input. So the identity reduces to `allowance = continuing + payments + fee`, and `input − continuing` is the entire outflow. The validator never has to trust which outputs the agent chose to list, and nothing can leave uncounted.
4. Every asset in the delta must be in `caps`. Per asset, the delta must be ≤ `tx_cap` and the new spent total must be ≤ `window_cap`. Also `fee ≤ max_fee`.
5. There is exactly one output at the vault payment credential, the continuing output. It sits at the exact canonical address, holds the same token, has no reference script, and its **inline datum equals the datum the validator computes**. The agent never writes its own datum.
6. Every other output's address must **equal** an allowed destination address exactly.
7. The validity range must have finite bounds. They are normalized for inclusive/exclusive (the ledger gives lower bound inclusive, upper bound exclusive).
   - The whole range must lie inside **one** window. If the range starts past the current window, the window rolls forward and `spent` resets.
   - The range must lie entirely before `expires_at`.
   - Its width must be ≤ `config.max_tx_validity_ms`.
8. The config ref input is found by its NFT at the canonical address. It must have `paused == false` and `agent ∉ owners`.
9. The agent's key must be in `extra_signatories`. Owner signatures are never read on this path.
10. `intent_hash` must be 32 bytes. The full JSON intent goes in tx metadata, and the SDK checks that its hash matches.

### 2.5 Off-chain shape
```
onchain/   Aiken project: validators/vault.ak, lib/{types,config,allowance,window,value}.ak, tests
sdk/       TS: owner.ts, agent.ts, cosign.ts, chain.ts (provider + tx chaining), guards.ts (network, address checks)
signer/    A separate process that holds the agent key. It re-checks every tx, applies rate limits, and returns only witnesses.
cli/       A CLI for every flow
demo/      A preprod end-to-end script
```
The LLM or agent process **never holds a key**. It builds unsigned CBOR and sends it to `signer/` over a Unix socket. The signer decodes the tx, checks it against its own policy (destinations, amounts, a per-hour tx count, a daily budget), signs, and returns the witness set.

## 3. Threat model: handling for every edge

Legend:
- **OC** is an on-chain check with an adversarial test that must fail.
- **LG** means the ledger enforces it, with an integration test on Yaci or preprod.
- **OFF** is an off-chain mitigation.
- **DOC** is out of scope, with the reason given.

### Value
| # | Edge | Handling |
|---|---|---|
| V1 | Absurd fee as a drain | OC. The fee is inside the input−continuing delta, so it counts against the lovelace cap. `fee ≤ max_fee` is also checked. |
| V2 | Change or dust to the agent's own address | OC. There is no separate change: the delta counts everything. The agent's own address is also not a destination unless owners whitelist it. |
| V3 | Mint or burn inside an agent spend | OC. `mint` must be empty. |
| V4 | Non-whitelisted tokens riding along | OC. Any nonzero delta asset outside `caps` fails. The only possible source is the one allowance input. |

### UTxO structure
| # | Edge | Handling |
|---|---|---|
| U1 | Double satisfaction | OC. The tx has exactly one input. On owner paths, each allowance's continuing output is identified by its unique token. |
| U2 | Splitting to multiply the cap | OC. Each token has quantity 1, there is exactly one vault output, and the agent cannot mint. |
| U3 | Fake allowance UTxOs | OC. The role comes from the vault token, and only the owner threshold can mint one. A planted UTxO is treated as treasury. |
| U4 | Continuing output bloated with junk or a huge datum | OC. Without mint or extra inputs, continuing ⊆ input. The datum must equal the computed one, and reference scripts are rejected. Creation caps list sizes. |
| U5 | Datum by hash | OC. The continuing output and all created outputs need an inline datum. |
| U6 | Malformed datum | The spend handler takes `Option<Data>`. `AgentSpend` decodes the datum and fails on bad data. `OwnerManage` never decodes the datum, so reclaim needs only the owner threshold and the token. The agent cannot write a malformed datum (U4). The test plants a corrupt datum via the emulator, checks that the agent fails, and checks that the owner reclaims. |

### Time
| # | Edge | Handling |
|---|---|---|
| T1 | Unbounded lower or upper bound | OC. Both bounds must be finite. |
| T2 | A range that straddles or stretches a window | OC. The whole normalized range must sit inside one window, and its width must be ≤ `max_tx_validity_ms`. |
| T3 | Off-by-one at edges | OC. Normalization is explicit. Tests at ws−1, ws, ws+P−1 and ws+P, with inclusive and exclusive bounds. |
| T4 | Period 0, future start, overflow | OC. `period_ms > 0` is checked at creation and edit. Before `window_start` no spend is possible, because lo ≥ window_start is required. Plutus integers are unbounded, so overflow cannot occur. Negative values are rejected by validation. |

### Destinations and config
| # | Edge | Handling |
|---|---|---|
| D1 | Swapped stake credential | OC. The whole address must be equal. Tests cover a swapped stake credential, an added stake credential, a removed stake credential, and a pointer address. |
| D2 | Membership proofs | DOC/OC. **There is no proof scheme.** An inline list with at most 10 entries means proof reuse and wrong-set attacks have no proof to attack. An empty set is rejected at creation. MPF is a post-MVP option if lists need to exceed about 10. |
| D3 | Allowlist or config so big it blows the budget | OC. Config sizes are capped at write time. Allowance sizes are capped at read time, and an oversize allowance fails closed, after which owners reclaim it. `scripts/budget.sh` asserts the max-size agent, co-sign and reclaim paths each use < 50% of the tx limit. Measured: 35% mem / 20% cpu worst case, and that includes building the test tx. |
| D4 | Forged or stale config | OC/LG. The config is found by a one-shot NFT at the canonical address. A reference input must be unspent (ledger rule), so a stale config makes the tx invalid. |
| D5 | Invalid owner sets | OC. `validate_config` covers 1 ≤ threshold ≤ len, at least 1 owner, no duplicates and len ≤ 10. It runs on init and on every rotation. Covered by property tests. |
| D6 | Agent key is also an owner key | OC. Checked **on every agent and co-signed spend** against the live config, which covers allowances created before a rotation. The SDK also checks it at creation. |

### Revocation
| # | Edge | Handling |
|---|---|---|
| R1 | Front-running a revoke | DOC. The loss is bounded by the remaining cap in the current window. It is stated in the README. |
| R2 | Revoke and spend in the same block | LG. Both consume the same UTxO, so exactly one wins. |

### Infra
| # | Edge | Handling |
|---|---|---|
| I1 | Stake credential deregistration | DOC. **The vault has no stake credential** (enterprise address) and no withdraw-zero, so there is nothing to deregister. |
| I2 | Unwithdrawable rewards | DOC. There is no stake credential, so no rewards accrue. Tradeoff: the treasury is not staked. ADA someone sends to vault-payment + their own stake goes to the sender's rewards. Owners can still spend it. |
| I3 | Reference script UTxO removed | LG/OFF. It is deployed to an always-fails address. The SDK checks the script hash and falls back to an inline script, so losing it cannot brick spends. |
| I4 | Allowance used as collateral | LG. Babbage+ collateral must be key-locked. The agent pays collateral from its own small key UTxO. Test on Yaci. |
| I5 | Network id mixups | LG/OFF. Plutus cannot see network ids. The ledger rejects wrong-network outputs (`WrongNetwork`). The SDK asserts network id 0, magic 1, and a provider tip check, and refuses mainnet. |
| I6 | Provider inconsistency | OFF. One provider per session. Txs chain from the outputs of the built tx. The UTxO is re-checked by outref and token before every build. Retries refresh the UTxO set, and confirmation is awaited with the same provider. |

### Off-chain
| # | Edge | Handling |
|---|---|---|
| O1 | Hot key in the LLM process | OFF. The `signer/` process holds the key and the LLM never sees it. KMS/HSM is out of scope (no key custody). |
| O2 | Prompt injection drives max spends | OC bound plus OFF. The cap bounds the loss. The signer adds rate and budget limits. |
| O3 | Pre-signed txs held back | OC. Validity width is ≤ `max_tx_validity_ms`, so a tx dies when it expires. Any other spend also invalidates it, since its input is gone. |

## 4. What Cardano can't enforce exactly (tradeoffs)
1. **Fixed windows: any interval of length `period` can see up to 2× `window_cap`.** The attacker spends the cap at the end of window N and again at the start of N+1. Each single tx is also bounded by `tx_cap`. Decision: accepted. A sliding window is v2.
2. **"Now" is an interval, not a clock.** Scripts see only the validity range, at 1 s slot granularity, so the agent picks where in the window a spend falls.
3. **"Instant" pause or revoke means the next block that includes it.** Spends ordered earlier, or in the same block before it, still land.
4. **Intent is a commitment, not content.** Scripts cannot see metadata. The redeemer carries the 32-byte hash, and only off-chain tools check that it matches the metadata.
5. **The lovelace cap includes fees and min-ADA.** The agent cannot drain the continuing output below min-ADA, and it needs headroom for fees.
6. **Throughput is one spend per allowance per block** (about 20 s), because spends run in sequence on one UTxO. More throughput means more allowances.
7. **Owner/agent disjointness** is checked at grant and at spend, not at rotation.
8. **Pause blocks every path that needs an agent signature.** Cardano cannot stop an agent from adding its signature to an owner-only tx, but that tx needs the owner threshold anyway, so the extra signature grants nothing.

## 5. Milestones (each one ends with passing tests)
| M | Scope | Done when |
|---|---|---|
| M0 | Spike: install Aiken. Build an always-true V3 validator. In the Lucid emulator and on Yaci: a **single-input script spend** with fee taken from that input, an inline continuing datum, explicit collateral, POSIX validity, and partial sign + assemble from 3 keys. | The spike tests pass on both. The SDK choice is locked (Lucid or Blaze). |
| M1 | On-chain core: types, config validation, one-shot init, config rotation and pause, treasury owner spend | Unit + property tests pass, and D5 is covered |
| M2 | On-chain allowances: mint/edit/burn, AgentSpend, CoSignedSpend, window math | Every OC edge has a failing adversarial test, a property test (spent ≤ cap across random tx sequences), and budget benchmarks at max sizes |
| M3 | SDK (owner + agent + cosign) and signer process. Emulator integration plus an "attacker builder" that skips SDK guards. | All flows plus all OC edges replayed through real tx building pass in the emulator. The LG edges (I4, R2, I5, D4) pass on Yaci. |
| M4 | CLI for every flow | CLI smoke tests pass on Yaci |
| M5 | Preprod: deploy, then the full demo (pay allowed → blocked by cap → blocked by allowlist → over-limit co-sign → pause → revoke). Then the README. | The demo runs end to end on preprod, with tx hashes recorded |
| M6 | Migrate to stdlib v4, fuzz v3 and ADP v1.9.0 (before audit) | All tests still pass, and the script hash diff is explained |

## 5b. Reused patterns (where each one lands)

| Pattern | Source (pinned) | Used in | Notes |
|---|---|---|---|
| Validity range normalization | ADP v1.8.0 `validity-range-normalization` (dependency) | `window.ak`: every agent path | Only `ClosedRange` is accepted. Everything else fails (T1). |
| One-shot NFT parameterized by OutputReference | Sundae `validators/oneshot.ak` (audited; ported v2→v3) | `vault` mint `InitConfig` | Hardened: we also pin the token name and the destination address and datum. Sundae's version leaves those unconstrained. |
| NFT-authenticated reference-input config | Sundae `utilities.find_script_hash_registry` (ported) | `config.ak` lookup on every path | Hardened: it also checks the canonical address, because our config lives at a spendable address. |
| Reject reference scripts on outputs | Sundae `utilities.ensure_no_ref_scripts` (ported) | Agent and co-sign paths | Stops fee and min-ADA inflation |
| Malformed-datum escape hatch | Sundae `logic/vendor/malformed.ak` (ported idea) | `OwnerManage`: reclaim never decodes the datum | Sundae audit finding 3.14 (stealing malformed inputs during reorganize) is why reclaim and treasury paths stay owner-threshold only |
| Threshold multisig | aicone `sundae/multisig.satisfied` (commit 504e104, copied: the `AtLeast` and `Signature` subset) | `owners.ak` | `AtLeast` double-counts duplicate keys, so `validate_config` must reject duplicates (D5) |
| Interval length bound | Sundae `utilities.interval_length_at_most` (ported) | Superseded by the normalized width check | Listed for traceability |
| Single-script-input / double-satisfaction guard | Sundae `ensure_compliant_scripts`, Plutonomicon | Strengthened to **exactly one input** on the agent path | |

Not used, with the reason:
- ADP singular and multi UTxO indexers: the one-input rule makes them unnecessary.
- ADP stake-validator (withdraw-zero): the vault has no stake credential.
- ADP merkelized-validator: no MPF in v1.
- ADP tx-level-minter and linked-list: no use case.

## 6. Prerequisites
- **Before M5:** a Blockfrost preprod project id, and about 1,000 tADA from the faucet sent to an address the CLI generates.
- All keys are test keys generated locally into `.keys/`, which is gitignored.
- The decisions on §4.1 (2× burst), D1 (pin the stake credential) and §4.8 (pause blocks co-sign) are recorded in §0.

## 7. Honest caveats
- **I found no audited Cardano allowance or session-key contract.** This is new design. The closest prior art is the Sundae/Intersect treasury-contracts (audited by TxPipe and MLabs), plus an IOG design proposal (contracts-library #11). Get an audit before any real value goes in.
- **ADP has no audit** (none found in the repo). Sundae's code is audited only at commit 504e104 on stdlib v2, so ported code is no longer audited code.
- The ledger behavior for unparseable datums is inferred, not documented. M0 and M2 tests will confirm it empirically.

## 8. Sources
- **Ledger and protocol:**
  - Ledger source (Conway TxInfo, TxCert, Deleg): https://github.com/IntersectMBO/cardano-ledger
  - Live protocol parameters: https://preprod.koios.rest/api/v1/cli_protocol_params
  - PV11 notes: https://intersectmbo.org/news/proposed-intra-era-hard-fork-to-protocol-version-11
- **Aiken:**
  - https://github.com/aiken-lang/aiken/releases
  - https://github.com/aiken-lang/stdlib/releases
  - https://aiken-lang.org/language-tour/validators
- **Security references:**
  - https://www.mlabs.city/blog/common-plutus-security-vulnerabilities
  - https://github.com/Plutonomicon/plutonomicon
  - https://github.com/Anastasia-Labs/aiken-design-patterns
  - https://www.tweag.io/blog/2026-07-23-cardano-audits-retrospective/
- **Prior art:**
  - https://github.com/SundaeSwap-finance/treasury-contracts
  - https://github.com/input-output-hk/contracts-library/issues/11
  - https://github.com/Anastasia-Labs/aiken-upgradable-multisig
- **SDKs:**
  - https://github.com/Anastasia-Labs/lucid-evolution
  - https://github.com/butaneprotocol/blaze-cardano
  - https://github.com/IntersectMBO/evolution-sdk
  - https://github.com/bloxbean/yaci-devkit

## 9. Progress log
- **M0 (done):** 6/6 spike tests pass, in the emulator and on a Yaci PV11 node. Lucid is kept. See `spike/README.md`.
- **M1 (done):** config validation, one-shot init, rotation, pause and unpause, treasury paths.
- **M2 (on-chain done):** the allowance mint and burn, `AgentSpend`, `CoSignedSpend`, and window math.
  - **Tests:** 177 Aiken tests (163 unit/adversarial, 14 property).
  - **Mutations:** `scripts/mutations.tsv` (68 mutations, all must be killed). Run it with `scripts/mutate-all.sh`.
  - **Budget:** `scripts/budget.sh`.
  - **Findings from mutation testing.** Each was fixed, either by a new test or by removing a redundant check:
    - The redundant `n >= 1` check was removed.
    - The builder now mirrors the validator's floor division, so the "future window start" test fails on the time check rather than on a datum mismatch.
    - New test: a split mint of an allowance name across two outputs.
    - New test: a capped token added to the continuing output.
    - New test: a well-typed but malformed datum on the co-signed path.
- **M3 test split (finding).** Lucid's `Emulator.submitTx` checks witnesses but **does not run Plutus scripts**, so it cannot judge adversarial txs.
  - The emulator runs honest-flow SDK tests only.
  - Every adversarial edge is replayed as a raw tx against the Yaci node (cardano-node 11.0.1, PV11), which executes the scripts for real.
- **M3 (done):** SDK (owner, agent, co-sign, chain, limits mirror, intents, guards) plus the signer daemon.
  - **Unit and emulator:** 28 tests. These cover every honest flow, and Lucid's local UPLC run of the real validator checks every one. The signer daemon test runs over a Unix socket.
  - **Real node:** `test/yaci/adversarial.test.ts` passes **34/34** on Yaci v0.11.0-beta1 (cardano-node 10.5.0, PV10).
    - The attacker builder skips every SDK guard and all script evaluation; only the validator and the ledger judge.
    - A baseline test proves its honest tx is accepted.
  - **Devnet findings:**
    - Yaci v0.12.0-beta5 (PV11) stalls after its Yano-to-Haskell block-producer hand-off, so it is not usable for long runs. Before stalling it reached 33/34; the one failure was a test bug, since fixed.
    - Yaci v0.11's store omits `cost_models_raw`, and its named V2 map is out of order. The harness injects the node's raw arrays from Ogmios.
    - PV11-specific evidence comes from the preprod demo (M5).
- **M4 (done):** `cli/vault` covers every flow. Multi-party commands sign locally with `--sign` or work offline through `--out`, `tx witness` and `tx assemble`. `cli/test/smoke.sh` passes 17/17 on the devnet.
- **M5 (done):** `demo/preprod.sh run` passed end to end on **preprod (PV11)**. All 12 txs are recorded in `demo/RESULTS.md`, and the 5 refusals worked as intended. Key txs were independently checked via Koios: the agent spend has exactly 1 input, the script executed, and the intent hash is in metadata.
  - **Edge I6 found on preprod, twice, and fixed:**
    1. After a tx confirms, Blockfrost's address index still listed spent inputs. Fix: `awaitSettled` waits until each output address shows the new outputs and none of the spent inputs.
    2. Even cross-checked reads could be stale, which fits load-balanced backends at different heights. Fix: the CLI re-reads state and rebuilds when the node answers "inputs already spent". eUTxO makes the rebuild safe. It fired once, live, during the revoke step.
- **M6 (done):** migrated to Aiken v1.1.24, stdlib v4.0.0, fuzz v3.0.0 and ADP v1.9.0. The validators came out byte-identical (commit `a1fde7a`), so the script hashes didn't change.
- **After `mvp-v0.1`:**
  - **Renamed to Gendo.** The rename is hash-neutral: rebuilt and checked against the audit brief's hashes.
  - **`is_well_formed` now requires `0 < tx_cap ≤ window_cap`** for every cap, matching §2.2. A zero cap used to deny one asset; it now makes the whole allowance malformed. To forbid an asset, leave it out of `caps`. This changes the vault hash; see `docs/AUDIT_BRIEF.md`.
  - **Signer:** it now pins the one allowance it serves, keeps a daily budget per asset (deny by default), requires exactly one input on the co-signed path too, and `describeTx` names only the vault's own redeemers.
