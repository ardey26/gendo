// Connecting an agent without a terminal: the agent's key signs short messages to prove it holds
// the key, and both sides show three words made from the key so owners can check it's the same one.
import { CML } from "@lucid-evolution/lucid";
import { fromHex, toHex, utf8ToHex } from "./bytes.js";

const A = ["amber", "bold", "brave", "calm", "clever", "cosmic", "crisp", "dusty", "eager", "fancy", "gentle", "golden", "happy", "hidden", "icy", "jolly", "kind", "lucky", "mellow", "misty", "noble", "odd", "proud", "quiet", "rapid", "royal", "shy", "silver", "sunny", "swift", "tidy", "wild"];
const B = ["badger", "bison", "crane", "eagle", "falcon", "ferret", "gecko", "heron", "ibis", "jackal", "koala", "lemur", "lynx", "marten", "moose", "newt", "ocelot", "otter", "panda", "pelican", "puffin", "quail", "raven", "seal", "shark", "sloth", "swan", "tapir", "tiger", "walrus", "wombat", "yak"];

/** Three words from a key hash: what owners compare with what the agent shows. */
export function confirmWords(pkh: string): string {
  const b = fromHex(pkh);
  return `${A[b[0]! % 32]}-${B[b[1]! % 32]}-${(b[2]! * 256 + b[3]!) % 100}`;
}

export const pairingMessage = (code: string) => `gendo pairing ${code}`;
export const statusMessage = (ms: number) => `gendo status ${ms}`;

export function signMessage(skBech32: string, message: string): { publicKey: string; signature: string } {
  const sk = CML.PrivateKey.from_bech32(skBech32);
  return { publicKey: toHex(sk.to_public().to_raw_bytes()), signature: sk.sign(fromHex(utf8ToHex(message))).to_hex() };
}

/** The signer's key hash if `signature` is `publicKey`'s signature over `message`; otherwise undefined. */
export function verifyMessage(publicKey: string, message: string, signature: string): string | undefined {
  try {
    const pk = CML.PublicKey.from_bytes(fromHex(publicKey));
    return pk.verify(fromHex(utf8ToHex(message)), CML.Ed25519Signature.from_hex(signature)) ? pk.hash().to_hex() : undefined;
  } catch {
    return undefined;
  }
}
