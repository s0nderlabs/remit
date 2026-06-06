// Probe 0 (local env) + Probe 5 (getCapabilities / getFeeData schema on both chains).
import { getCapabilities, getFeeData, envFor, CHAINS, type ChainId } from "./lib";

async function run() {
  for (const cid of [84532, 8453] as ChainId[]) {
    const c = CHAINS[cid];
    console.log(`\n========== ${c.name} (${cid}) ==========`);

    // ---- Probe 0: local SDK environment ----
    const env = envFor(cid);
    console.log("[probe0] DelegationManager:", env.DelegationManager);
    console.log(
      "[probe0] EIP7702StatelessDeleGatorImpl:",
      env.implementations.EIP7702StatelessDeleGatorImpl,
    );
    console.log(
      "[probe0] ERC20PeriodTransferEnforcer:",
      env.caveatEnforcers.ERC20PeriodTransferEnforcer,
    );

    // ---- relayer_getCapabilities ----
    const caps = await getCapabilities(cid);
    console.log(`[probe5] getCapabilities http=${caps.httpStatus}`);
    console.log("[probe5] getCapabilities raw:", caps.raw.slice(0, 2000));

    // ---- relayer_getFeeData for USDC ----
    const fee = await getFeeData(cid, c.usdc);
    console.log(`[probe5] getFeeData(USDC) http=${fee.httpStatus}`);
    console.log("[probe5] getFeeData raw:", fee.raw.slice(0, 2000));
  }
}

run().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
