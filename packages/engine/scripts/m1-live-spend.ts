// M1 MILESTONE: a card is issued and spends REAL USDC on Base mainnet through the
// REAL engine code path (compiler -> custody -> store -> carve -> estimate -> send
// -> getStatus -> receipt -> counters). ~0.02 USDC total (0.01 work to our own
// merchant key, recoverable; 0.01 relayer fee, burned).
//
// Run (from packages/engine):
//   set -a; source ../../.dev/dev.env; source ../../probes/.env.funded; source ../../probes/.env.phaseb; set +a
//   bun run scripts/m1-live-spend.ts

import { createPublicClient, erc20Abi, formatUnits, http, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Store } from "../src/store";
import { Relayer } from "../src/relayer";
import { issueRootCard } from "../src/issuance";
import { spend, cardState } from "../src/spend";
import { CHAINS, FEE_COLLECTOR, rpcUrl } from "../src/chains";

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

const CID = 8453 as const;
const USDC = CHAINS[CID].usdc;

async function main() {
  const user = privateKeyToAccount(reqEnv("FUNDED_USER_PK") as Hex);
  const merchant = reqEnv("MERCHANT_ADDRESS") as Address;
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl(CID)) });

  const bal = async (a: Address) =>
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  const before = { user: await bal(user.address), merchant: await bal(merchant), fees: await bal(FEE_COLLECTOR) };
  console.log(`A_user ${user.address}: ${formatUnits(before.user, 6)} USDC`);
  console.log(`merchant ${merchant}: ${formatUnits(before.merchant, 6)} USDC`);

  const store = new Store(); // REMIT_DB_PATH from env
  store.upsertUser({ id: "elpabl0-dev", address: user.address });

  console.log("\n[1/3] issuing card through the engine (reads live revocation nonce)...");
  const issued = await issueRootCard(
    { store, userSigner: user },
    {
      userId: "elpabl0-dev",
      name: "M1 dev card",
      terms: { pay: { period: { amount: "25", seconds: 604800 } }, expiry: Math.floor(Date.now() / 1000) + 30 * 86400 },
    },
  );
  console.log(`   card ${issued.cardId}`);
  console.log(`   K_agent ${issued.kAgentAddress} (bare EOA, holds nothing)`);
  console.log(`   bearer URL would be /c/${issued.secret.slice(0, 8)}.../mcp`);

  console.log("\n[2/3] spending 0.01 USDC -> merchant through the spend pipeline...");
  const t0 = Date.now();
  const receipt = await spend(
    { store, relayer: new Relayer(CID) },
    issued.cardId,
    { kind: "pay", mode: "pay", to: merchant, amountAtoms: 10_000n, memo: "M1 milestone", idempotencyKey: `m1-${Date.now()}` },
  );
  console.log(`   receipt:`, JSON.stringify(receipt, null, 2));
  console.log(`   wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log("\n[3/3] on-chain verification...");
  const after = { user: await bal(user.address), merchant: await bal(merchant), fees: await bal(FEE_COLLECTOR) };
  console.log(`   A_user    ${formatUnits(before.user, 6)} -> ${formatUnits(after.user, 6)} (Δ ${formatUnits(after.user - before.user, 6)})`);
  console.log(`   merchant  ${formatUnits(before.merchant, 6)} -> ${formatUnits(after.merchant, 6)} (Δ +${formatUnits(after.merchant - before.merchant, 6)})`);
  console.log(`   collector ${formatUnits(before.fees, 6)} -> ${formatUnits(after.fees, 6)} (Δ +${formatUnits(after.fees - before.fees, 6)})`);

  const state = cardState(store, issued.cardId, Math.floor(Date.now() / 1000))!;
  console.log(`   counters: remaining_this_period=${state.remaining_this_period}, resets=${state.period_resets_at}`);

  const ok =
    receipt.status === "confirmed" &&
    after.merchant - before.merchant === 10_000n &&
    before.user - after.user === 20_000n;
  console.log(`\nM1 ${ok ? "PASS ✅" : "FAIL ❌"}`);
  if (!ok) process.exit(1);
}

await main();
