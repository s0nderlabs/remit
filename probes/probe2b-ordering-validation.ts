// Probe 2b: validation-order discrimination for Plan A.
// Goal: confirm whether the "ERC20 transfer amount exceeds balance" in probe 2
// means the full delegation chain (incl. bare-EOA leaf signature + redelegation
// authority) was actually verified on-chain, or whether balance is checked first.
//
// Method: take the working chain-2 (leaf,root, user auth) and corrupt ONE factor
// at a time, observing whether the error changes from balance -> signature/authority.

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

type Corrupt = "none" | "leafSig" | "rootSig" | "leafAuthority";

export async function run(cid: ChainId, corrupt: Corrupt) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  console.log(`\n----- PROBE 2b ${c.name} corrupt=${corrupt} -----`);

  const user = freshKey();
  const agent = freshKey();
  const smartUser = await buildStateless7702(cid, user.address, user.account);
  const now = Math.floor(Date.now() / 1000);

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
    delegate: agent.address,
    delegator: user.address,
    authority: ROOT_AUTHORITY,
    caveats: rootCaveats as any,
    salt: freshSalt(),
    signature: "0x",
  };
  const rootSig = await smartUser.signDelegation({
    delegation: root,
    chainId: Number(cid),
  });
  let rootSigned: Delegation = { ...root, signature: rootSig };
  if (corrupt === "rootSig") {
    rootSigned = { ...rootSigned, signature: ("0x" + "11".repeat(65)) as any };
  }

  const feeAtoms = usdc(0.02);
  const payAtoms = usdc(1.0);
  let leaf: Delegation = createDelegation({
    environment: env,
    from: agent.address,
    to: c.targetAddress,
    parentDelegation: rootSigned,
    scope: {
      type: ScopeType.Erc20TransferAmount,
      tokenAddress: c.usdc,
      maxAmount: feeAtoms + payAtoms,
    },
    salt: freshSalt(),
  });
  if (corrupt === "leafAuthority") {
    leaf = { ...leaf, authority: ROOT_AUTHORITY }; // detach from root
  }
  let leafSig = await signDelegation({
    privateKey: agent.pk,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  if (corrupt === "leafSig") {
    leafSig = ("0x" + "22".repeat(65)) as any;
  }
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  const merchant = freshKey().address;
  const executions = [
    erc20TransferExecution(c.usdc, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(c.usdc, merchant, payAtoms),
  ];
  const a = await sign7702Auth(cid, user.account);
  const authEntry = {
    chainId: a.chainId,
    address: a.address,
    nonce: a.nonce,
    yParity: a.yParity,
    r: a.r,
    s: a.s,
  };

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  const r = await estimate(cid, [{ permissionContext, executions }], [authEntry]);
  console.log(`[p2b] http=${r.httpStatus} raw=`, r.raw.slice(0, 400));
  return r;
}

if (import.meta.main) {
  await run(84532, "none");
  await run(84532, "leafSig");
  await run(84532, "rootSig");
  await run(84532, "leafAuthority");
}
