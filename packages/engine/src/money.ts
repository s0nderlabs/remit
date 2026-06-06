// USDC money math. 6 decimals. Decimal STRINGS at every boundary (no float drift);
// bigint atoms internally. The relayer's minFee comes back as a dollar-decimal
// string like "0.01" (= 10000 atoms), requiredPaymentAmount as an atoms string.

const USDC_DECIMALS = 6;
const ATOMS_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** "12.34" | "0.01" | "5" -> atoms bigint. Throws on malformed/negative/too-precise input. */
export function usdcToAtoms(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m || m[1] === undefined) throw new Error(`invalid USDC amount: ${JSON.stringify(amount)}`);
  const whole = m[1];
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`USDC amount has more than ${USDC_DECIMALS} decimals: ${amount}`);
  }
  return BigInt(whole) * ATOMS_PER_USDC + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** atoms bigint -> trimmed decimal string ("10000" atoms -> "0.01"). */
export function atomsToUsdc(atoms: bigint): string {
  if (atoms < 0n) throw new Error(`negative atoms: ${atoms}`);
  const whole = atoms / ATOMS_PER_USDC;
  const frac = (atoms % ATOMS_PER_USDC).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Parse an atoms-string field from the relayer (e.g. requiredPaymentAmount "10000"). */
export function parseAtoms(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new Error(`invalid atoms string: ${JSON.stringify(s)}`);
  return BigInt(s);
}
