// Probe 1: BASELINE single delegation.
// delegator = throwaway-A (Stateless7702 account object), delegate = targetAddress,
// scope = Erc20TransferAmount (maxAmount = fee+payment),
// executions = [feeTransfer, transfer to random addr], authorizationList = [signed 7702 auth for A].
// Expect: passes validation, fails on balance/simulation.

import {
  CHAINS,
  FEE_COLLECTOR,
  freshKey,
  freshSalt,
  buildStateless7702,
  envFor,
  wireDelegation,
  erc20TransferExecution,
  usdc,
  sign7702Auth,
  getFeeData,
  estimate,
  ScopeType,
  type ChainId,
  type Delegation,
} from "./lib";

export async function runBaseline(cid: ChainId) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  console.log(`\n===== PROBE 1 BASELINE on ${c.name} (${cid}) =====`);

  // throwaway A = delegator (the 7702-upgraded smart account)
  const A = freshKey();
  console.log("[p1] delegator A:", A.address);

  const smartA = await buildStateless7702(cid, A.address, A.account);

  // root delegation: A -> targetAddress, scope Erc20TransferAmount
  const feeAtoms = usdc(0.02); // >= minFee 0.01
  const payAtoms = usdc(1.0);
  const maxAmount = feeAtoms + payAtoms;

  const delegation: Delegation = {
    delegate: c.targetAddress,
    delegator: A.address,
    authority:
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    caveats: [],
    salt: freshSalt(),
    signature: "0x",
  } as any;

  // Build via SDK createDelegation to get proper scope caveats:
  const { createDelegation } = await import("@metamask/smart-accounts-kit");
  const built = createDelegation({
    environment: env,
    from: A.address,
    to: c.targetAddress,
    scope: {
      type: ScopeType.Erc20TransferAmount,
      tokenAddress: c.usdc,
      maxAmount,
    },
    salt: freshSalt(),
  });

  // sign with the smart account (Stateless7702 signDelegation)
  const signature = await smartA.signDelegation({
    delegation: built,
    chainId: Number(cid),
  });
  const signed: Delegation = { ...built, signature };

  // executions: fee transfer FIRST, then payment transfer to a random addr
  const merchant = freshKey().address;
  const executions = [
    erc20TransferExecution(c.usdc, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(c.usdc, merchant, payAtoms),
  ];

  // authorizationList: signed 7702 auth for A
  const auth = await sign7702Auth(cid, A.account);
  const authEntry = {
    chainId: auth.chainId,
    address: auth.address,
    nonce: auth.nonce,
    yParity: auth.yParity,
    r: auth.r,
    s: auth.s,
  };

  const permissionContext = [wireDelegation(signed)];
  console.log("[p1] caveats on root:", signed.caveats.map((x) => x.enforcer));

  const r = await estimate(
    cid,
    [{ permissionContext, executions }],
    [authEntry],
  );
  console.log(`[p1] estimate http=${r.httpStatus}`);
  console.log("[p1] estimate raw:", r.raw);
  return r;
}

if (import.meta.main) {
  await runBaseline(84532);
}
