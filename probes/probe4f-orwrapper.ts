// Probe 4f (focused): LogicalOrWrapperEnforcer live-enforcement discrimination.
// Real enforcer 0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c (deployed both chains).
// Root delegation carries: erc20PeriodTransfer + OR-wrapper{ group0: AllowedCalldata(recipient==feeCollector),
//                                                            group1: AllowedCalldata(recipient==merchant) }.
// Leaf: agent -> targetAddress (Erc20TransferAmount). Chain-2 Plan A, user 7702 auth.
// Single fee execution to feeCollector (AllowedCalldata is single-call mode).
//
// Variants prove the wrapper is actually evaluated on-chain:
//   ok            : groupIndex 0, recipient==feeCollector  -> expect SIM(balance) (passes wrapper)
//   wrongGroup    : groupIndex 1 (merchant pin) but recipient is feeCollector -> expect AllowedCalldata revert
//   badGroupIndex : groupIndex 5 (out of range) -> expect LogicalOrWrapperEnforcer:invalid-group-index
//   badArgsLen    : groupIndex 0, caveatArgs length 2 (group has 1) -> expect invalid-caveat-args-length

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
  createCaveat,
  ScopeType,
  type ChainId,
  type Delegation,
} from "./lib";
import {
  createDelegation,
  signDelegation,
  ROOT_AUTHORITY,
} from "@metamask/smart-accounts-kit";
import {
  createLogicalOrWrapperTerms,
  createLogicalOrWrapperArgs,
  createAllowedCalldataTerms,
} from "@metamask/delegation-core";
import { pad } from "viem";

const LOGICAL_OR_WRAPPER_ENFORCER =
  "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c" as `0x${string}`;
const MERCHANT = "0xc29909c5e45f0c076830e02e6a36b5f3360743ed" as `0x${string}`;

type Variant = "ok" | "wrongGroup" | "badGroupIndex" | "badArgsLen";

export async function run(cid: ChainId, variant: Variant) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  const acEnforcer = env.caveatEnforcers.AllowedCalldataEnforcer as `0x${string}`;
  console.log(`\n----- PROBE 4f ${c.name} variant=${variant} -----`);

  const user = freshKey();
  const agent = freshKey();
  const smartUser = await buildStateless7702(cid, user.address, user.account);
  const now = Math.floor(Date.now() / 1000) - 300;

  const acTerms = (v: `0x${string}`) =>
    createAllowedCalldataTerms({ startIndex: 4, value: pad(v, { size: 32 }) }) as `0x${string}`;

  const orTerms = createLogicalOrWrapperTerms({
    caveatGroups: [
      [{ enforcer: acEnforcer, terms: acTerms(FEE_COLLECTOR), args: "0x00" }], // group 0: feeCollector
      [{ enforcer: acEnforcer, terms: acTerms(MERCHANT), args: "0x00" }], // group 1: merchant
    ] as any,
  }) as `0x${string}`;

  let orArgs: `0x${string}`;
  if (variant === "ok") orArgs = createLogicalOrWrapperArgs({ groupIndex: 0n, caveatArgs: ["0x00"] }) as `0x${string}`;
  else if (variant === "wrongGroup") orArgs = createLogicalOrWrapperArgs({ groupIndex: 1n, caveatArgs: ["0x00"] }) as `0x${string}`;
  else if (variant === "badGroupIndex") orArgs = createLogicalOrWrapperArgs({ groupIndex: 5n, caveatArgs: ["0x00"] }) as `0x${string}`;
  else orArgs = createLogicalOrWrapperArgs({ groupIndex: 0n, caveatArgs: ["0x00", "0x00"] }) as `0x${string}`;

  const periodCv = caveatBuilderFor(cid)
    .addCaveat("erc20PeriodTransfer", { tokenAddress: c.usdc, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
    .build();
  const rootCaveats = [...periodCv, createCaveat(LOGICAL_OR_WRAPPER_ENFORCER, orTerms, orArgs)];

  const root: Delegation = {
    delegate: agent.address,
    delegator: user.address,
    authority: ROOT_AUTHORITY,
    caveats: rootCaveats as any,
    salt: freshSalt(),
    signature: "0x",
  };
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(cid) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  const leaf = createDelegation({
    environment: env,
    from: agent.address,
    to: c.targetAddress,
    parentDelegation: rootSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) },
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: agent.pk,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  // single fee execution to feeCollector (single-call mode)
  const executions = [erc20TransferExecution(c.usdc, FEE_COLLECTOR, usdc(0.02))];

  const a = await sign7702Auth(cid, user.account);
  const authEntry = { chainId: a.chainId, address: a.address, nonce: a.nonce, yParity: a.yParity, r: a.r, s: a.s };

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  const r = await estimate(cid, [{ permissionContext, executions }], [authEntry]);
  console.log(`[4f:${variant}] http=${r.httpStatus} raw=`, r.raw.slice(0, 280));
  return r;
}

if (import.meta.main) {
  await run(84532, "ok");
  await run(84532, "wrongGroup");
  await run(84532, "badGroupIndex");
  await run(84532, "badArgsLen");
  // one mainnet confirmation
  await run(8453, "ok");
}
