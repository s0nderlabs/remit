// Full probe suite runner. Local-only. NEVER sends.
// Run: bun run index.ts        (testnet 84532, full)
//      bun run index.ts 8453   (mainnet repeat of key rows)
//
// Individual probes are runnable directly too:
//   bun run probe5-capabilities-fees.ts
//   bun run probe1-baseline.ts
//   bun run probe2-chain2.ts
//   bun run probe2b-ordering-validation.ts
//   bun run probe4-caveat-matrix.ts
//   bun run probe6-fee-requirement.ts
//   bun run probe-mainnet.ts

import { getCapabilities, getFeeData, envFor, CHAINS, type ChainId } from "./lib";
import { runBaseline } from "./probe1-baseline";
import { runChain2 } from "./probe2-chain2";
import { run as runOrderingValidation } from "./probe2b-ordering-validation";
import { runMatrix } from "./probe4-caveat-matrix";
import { run as runFeeReq } from "./probe6-fee-requirement";
import { run as runChain3 } from "./probe7-chain3";
import { runAll as runExecModes } from "./probe8-exec-modes";
import { runAll as runRootTotal } from "./probe9-root-total";

const cid = (Number(process.argv[2]) || 84532) as ChainId;

console.log(`### 1Shot Relayer caveat-composition probe suite -> ${CHAINS[cid].name} (${cid}) ###`);

// Probe 0: local env
const env = envFor(cid);
console.log("\n[probe0] EIP7702StatelessDeleGatorImpl:", env.implementations.EIP7702StatelessDeleGatorImpl);
console.log("[probe0] DelegationManager:", env.DelegationManager);

// Probe 5: capabilities + fee data
console.log("\n[probe5] getCapabilities:", (await getCapabilities(cid)).raw);
console.log("[probe5] getFeeData(USDC):", (await getFeeData(cid, CHAINS[cid].usdc)).raw);

// Probe 1: baseline
await runBaseline(cid);

// Probe 2/3: chain-2 Plan A + ordering + auth variants
await runChain2(cid, "leaf,root");
await runChain2(cid, "root,leaf");
await runChain2(cid, "leaf,root", { agentAuth: true });
await runChain2(cid, "leaf,root", { doubleAuth: true });

// Probe 2b: validation-order discrimination
await runOrderingValidation(cid, "none");
await runOrderingValidation(cid, "leafSig");
await runOrderingValidation(cid, "rootSig");
await runOrderingValidation(cid, "leafAuthority");

// Probe 4: caveat stack matrix
await runMatrix(cid);

// Probe 6: fee-execution requirement
await runFeeReq(cid, "noFee");
await runFeeReq(cid, "subMinFee");
await runFeeReq(cid, "okFee");

// Probe 7: chain-length-3 permissionContext (+ middle-link corruption)
await runChain3(cid, "ok");
await runChain3(cid, "corruptMiddle");

// Probe 8: execution-count vs redemption-mode mapping
await runExecModes(cid);

// Probe 9: ERC20TransferAmount as a root caveat (lifetime-total) + stacked
await runRootTotal(cid);

console.log("\n### suite complete ###");
