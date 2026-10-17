// The paired agent's signer: the same decision as the daemon, with its rules read from the allowance
// on every payment (so owners' edits apply at once) and the chain consulted about an earlier tx for the
// same intent (so a payment that never landed can be built again).
import type { AllowanceDatum } from "../../sdk/src/core/data.js";
import type { ChainQuery } from "../../sdk/src/core/idempotency.js";
import type { Vault } from "../../sdk/src/core/vault.js";
import { createSigner, policyFromAllowance } from "../../sdk/src/node/signer/core.js";
import type { SignerPolicy } from "../../sdk/src/node/signer/policy.js";

export function pairedSigner(o: {
  privateKey: string;
  unit: string;
  vault: Vault;
  network: Vault["network"];
  slot: SignerPolicy["slot"];
  readDatum: () => Promise<AllowanceDatum>;
  chain: ChainQuery | undefined;
  statePath?: string;
  now?: () => number;
}) {
  return createSigner({
    privateKey: o.privateKey,
    policy: async () => policyFromAllowance({ datum: await o.readDatum(), unit: o.unit, vault: o.vault, network: o.network, slot: o.slot }),
    ...(o.chain ? { chain: o.chain } : {}),
    ...(o.statePath ? { statePath: o.statePath } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
}
