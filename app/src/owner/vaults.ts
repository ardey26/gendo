// The server's list of your vaults is a convenience, not a source of truth: an entry is kept only
// when its vault id really names the vault its policy says, so a page never shows one vault and
// builds against another.
import type { MyVault } from "./api.ts";
import { vaultFromId } from "./chain.ts";

export const consistentVaults = (list: MyVault[]) =>
  list.filter((v) => {
    try {
      return vaultFromId(v.vaultId).hash === v.policy;
    } catch {
      return false;
    }
  });
