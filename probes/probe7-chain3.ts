// Probe 7: CHAIN LENGTH 3 permissionContext (deeper sub-card tree).
//
//   A_user (Stateless7702 root)  --root-->  A_agent1 (BARE EOA)
//     caveats: erc20PeriodTransfer(50/wk) + timestamp + nonce
//   A_agent1 --child--> A_agent2 (BARE EOA)
//     attenuated: erc20TransferAmount(maxAmount = fee+pay), a NARROWER cap
//   A_agent2 --leaf--> targetAddress (relayer)
//     scope: Erc20TransferAmount(maxAmount = fee+pay)
//
// All of A_agent1, A_agent2 are BARE EOAs (no 7702 code, no authorizationList entry).
// authorizationList = [A_user's signed 7702 authorization] ONLY (exactly-one guard).
// permissionContext = [leaf, child, root]  (LEAF-FIRST).
// Executions: fee transfer to feeCollector + small work transfer to a merchant.
//
// Expected: accepted-to-simulation (balance failure on unfunded key) -> proves a
// 3-hop redelegation chain validates end-to-end through the relayer.
//
// Corruption test: corrupt the MIDDLE (child) delegation's signature and confirm the
// error names a signature failure (ECDSAInvalidSignature) -> proves the FULL chain
// (including the middle link) is actually validated, not just leaf+root.

import {
  CHAINS,
  FEE_COLLECTOR,
  freshKey,
  freshSalt,
  buildStateless7702,
  envFor,
  caveatBuilderFor,
  wireDelegation,
  erc20TransferExecution,
  usdc,
  sign7702Auth,
  estimate,
  ScopeType,
  type ChainId,
  type Delegation,
} from "./lib";
import {
  createDelegation,
  signDelegation,
  ROOT_AUTHORITY,
} from "@metamask/smart-accounts-kit";

const ZERO_NONCE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

type Variant = "ok" | "corruptMiddle";

export async function run(cid: ChainId, variant: Variant = "ok") {
  const c = CHAINS[cid];
  const env = envFor(cid);
  console.log(`\n----- PROBE 7 CHAIN-3 ${c.name} (${cid}) variant=${variant} -----`);

  const user = freshKey(); // A_user: 7702 root delegator
  const agent1 = freshKey(); // A_agent1: BARE EOA (middle redelegator)
  const agent2 = freshKey(); // A_agent2: BARE EOA (leaf redelegator)
  console.log("[p7] A_user  (root, 7702):", user.address);
  console.log("[p7] A_agent1(middle, EOA):", agent1.address);
  console.log("[p7] A_agent2(leaf, EOA):", agent2.address);

  const smartUser = await buildStateless7702(cid, user.address, user.account);
  const now = Math.floor(Date.now() / 1000) - 300; // period active (start in past)

  const feeAtoms = usdc(0.02);
  const payAtoms = usdc(1.0);
  const capAtoms = feeAtoms + payAtoms;

  // ---- root: A_user -> A_agent1, period + timestamp + nonce ----
  const rootCaveats = caveatBuilderFor(cid)
    .addCaveat("erc20PeriodTransfer", {
      tokenAddress: c.usdc,
      periodAmount: usdc(50),
      periodDuration: 604800,
      startDate: now,
    })
    .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
    .addCaveat("nonce", { nonce: ZERO_NONCE })
    .build();

  const root: Delegation = {
    delegate: agent1.address,
    delegator: user.address,
    authority: ROOT_AUTHORITY,
    caveats: rootCaveats as any,
    salt: freshSalt(),
    signature: "0x",
  };
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(cid) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  // ---- child (MIDDLE): A_agent1 -> A_agent2, attenuated erc20TransferAmount ----
  const child = createDelegation({
    environment: env,
    from: agent1.address,
    to: agent2.address,
    parentDelegation: rootSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: capAtoms },
    salt: freshSalt(),
  });
  let childSig = await signDelegation({
    privateKey: agent1.pk,
    delegation: child,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  if (variant === "corruptMiddle") {
    childSig = ("0x" + "33".repeat(65)) as any; // corrupt the MIDDLE link's signature
  }
  const childSigned: Delegation = { ...child, signature: childSig };

  // ---- leaf: A_agent2 -> targetAddress, Erc20TransferAmount ----
  const leaf = createDelegation({
    environment: env,
    from: agent2.address,
    to: c.targetAddress,
    parentDelegation: childSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: capAtoms },
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: agent2.pk,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  // executions: fee + work
  const merchant = freshKey().address;
  const executions = [
    erc20TransferExecution(c.usdc, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(c.usdc, merchant, payAtoms),
  ];

  // authorizationList = [A_user] ONLY (the bare-EOA agents get none)
  const a = await sign7702Auth(cid, user.account);
  const authEntry = { chainId: a.chainId, address: a.address, nonce: a.nonce, yParity: a.yParity, r: a.r, s: a.s };

  // LEAF-FIRST: [leaf, child, root]
  const permissionContext = [
    wireDelegation(leafSigned),
    wireDelegation(childSigned),
    wireDelegation(rootSigned),
  ];

  const r = await estimate(cid, [{ permissionContext, executions }], [authEntry]);
  console.log(`[p7:${variant}] http=${r.httpStatus} raw=`, r.raw.slice(0, 400));
  return r;
}

if (import.meta.main) {
  await run(84532, "ok");
  await run(84532, "corruptMiddle");
  await run(8453, "ok");
  await run(8453, "corruptMiddle");
}
