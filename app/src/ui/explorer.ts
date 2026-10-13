// Transactions and addresses link to a public explorer (Cardanoscan, preprod). The local devnet
// has none, so there they stay plain text.
export function explorerUrl(network: string, value: string): string | undefined {
  if (network !== "Preprod") return undefined;
  if (/^[0-9a-f]{64}$/.test(value)) return `https://preprod.cardanoscan.io/transaction/${value}`;
  if (/^addr_test1[02-9ac-hj-np-z]+$/.test(value)) return `https://preprod.cardanoscan.io/address/${value}`;
  return undefined;
}
