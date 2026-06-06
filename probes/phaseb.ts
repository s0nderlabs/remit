// Phase B orchestrator: FUNDED MAINNET sends through the 1Shot Public Relayer (Base 8453).
// Authorized for Phase B only. Estimate FIRST every send; send IMMEDIATELY (context ~45s).
//
// Steps (run individually):
//   bun run phaseb.ts step1   -> funded estimate capture (chain-2), no send
//   bun run phaseb.ts send1   -> SEND #1 (chain-2 milestone, with authorizationList)
//   bun run phaseb.ts send2   -> SEND #2 (chain-3 A2A, no authorizationList)
//   bun run phaseb.ts send3   -> SEND #3 (OR-group merchant pin)
//   bun run phaseb.ts send4   -> SEND #4 (swap probe, stretch)
//   bun run phaseb.ts snap    -> print balances/code/eth snapshot

import {
  CID,
  C,
  USDC,
  FEE_COLLECTOR,
  loadAccounts,
  userAuth,
  ZERO_NONCE,
  buildStateless7702,
  envFor,
  caveatBuilderFor,
  wireDelegation,
  erc20TransferExecution,
  usdc,
  estimate,
  send,
  freshSalt,
  createDelegation,
  signDelegation,
  ROOT_AUTHORITY,
  ScopeType,
  snapshot,
  pub,
  type Delegation,
  type WireExecution,
} from "./phaseb-lib";
import {
  createLogicalOrWrapperTerms,
  createLogicalOrWrapperArgs,
  createAllowedCalldataTerms,
} from "@metamask/delegation-core";
import { pad, encodeFunctionData, formatUnits, type Address, type Hex } from "viem";

const LOGICAL_OR_WRAPPER =
  "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c" as Address;
const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseEstimate(r: { httpStatus: number; raw: string; parsed: any }) {
  const result = r.parsed?.result;
  const err = r.parsed?.error;
  return {
    http: r.httpStatus,
    success: result?.success,
    requiredPaymentAmount: result?.requiredPaymentAmount,
    context: result?.context,
    fullResult: result,
    rpcError: err,
    raw: r.raw,
  };
}

// poll relayer_getStatus({chainId, id}) until receipt has a transactionHash, then
// confirm on-chain. The send method returns a REQUEST ID, not the tx hash.
async function pollStatus(reqId: string) {
  const { relayerCall } = await import("./phaseb-lib");
  let txHash: string | null = null;
  let statusCode: number | null = null;
  for (let i = 0; i < 40; i++) {
    const r = await relayerCall(CID, "relayer_getStatus", { chainId: String(CID), id: reqId } as any);
    const res = r.parsed?.result;
    statusCode = res?.status ?? null;
    txHash = res?.receipt?.transactionHash ?? null;
    if (txHash) break;
    await new Promise((res2) => setTimeout(res2, 2000));
  }
  console.log(`  relayer status=${statusCode} txHash=${txHash}`);
  if (!txHash) {
    console.log("  WARN: no transactionHash from relayer status after polling");
    return { reqId, statusCode, txHash: null as string | null, onchain: null as any };
  }
  // confirm on-chain
  let onchain: any = null;
  for (let i = 0; i < 40; i++) {
    try {
      const rcpt = await pub().getTransactionReceipt({ hash: txHash as `0x${string}` });
      onchain = { status: rcpt.status, block: rcpt.blockNumber.toString(), gasUsed: rcpt.gasUsed.toString() };
      break;
    } catch {
      await new Promise((res2) => setTimeout(res2, 2000));
    }
  }
  console.log(`  on-chain: status=${onchain?.status} block=${onchain?.block} gasUsed=${onchain?.gasUsed}`);
  console.log(`  basescan: https://basescan.org/tx/${txHash}`);
  return { reqId, statusCode, txHash, onchain };
}

async function printSnap(label: string) {
  const { user, merchant, agent1, agent2 } = loadAccounts();
  const snap = await snapshot({
    A_user: user.address,
    A_agent1: agent1.address,
    A_agent2: agent2.address,
    MERCHANT: merchant.address,
    feeCollector: FEE_COLLECTOR,
  });
  console.log(`\n=== Balances ${label} ===`);
  for (const [name, v] of Object.entries(snap)) {
    console.log(`  ${name.padEnd(13)} USDC=${v.usdc.padStart(10)}  code=${v.code === "0x" ? "none" : v.code.slice(0, 12) + "..."}  ETH=${v.eth}`);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// COMPOSITION BUILDERS
// ---------------------------------------------------------------------------

// chain-2: A_user(7702 root) -> A_agent1(bare EOA leaf) -> relayer target
async function composeChain2(feeAtoms: bigint, workAtoms: bigint) {
  const env = envFor(CID);
  const { user, merchant, agent1 } = loadAccounts();
  const smartUser = await buildStateless7702(CID, user.address, user);
  const now = Math.floor(Date.now() / 1000) - 300;

  const rootCaveats = caveatBuilderFor(CID)
    .addCaveat("erc20PeriodTransfer", {
      tokenAddress: USDC,
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
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(CID) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  const leaf = createDelegation({
    environment: env,
    from: agent1.address,
    to: C.targetAddress,
    parentDelegation: rootSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: USDC, maxAmount: feeAtoms + workAtoms },
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: ("0x" + (process.env.AGENT1_PK as string).replace(/^0x/, "")) as Hex,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(CID),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  const executions: WireExecution[] = [
    erc20TransferExecution(USDC, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(USDC, merchant.address, workAtoms),
  ];
  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  return { permissionContext, executions, user, merchant, agent1 };
}

// chain-3: A_user(7702 root) -> A_agent1(bare EOA middle) -> A_agent2(bare EOA leaf) -> target
async function composeChain3(feeAtoms: bigint, workAtoms: bigint) {
  const env = envFor(CID);
  const { user, merchant, agent1, agent2 } = loadAccounts();
  const smartUser = await buildStateless7702(CID, user.address, user);
  const now = Math.floor(Date.now() / 1000) - 300;
  const cap = feeAtoms + workAtoms;

  const rootCaveats = caveatBuilderFor(CID)
    .addCaveat("erc20PeriodTransfer", {
      tokenAddress: USDC,
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
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(CID) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  const child = createDelegation({
    environment: env,
    from: agent1.address,
    to: agent2.address,
    parentDelegation: rootSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: USDC, maxAmount: cap },
    salt: freshSalt(),
  });
  const childSig = await signDelegation({
    privateKey: ("0x" + (process.env.AGENT1_PK as string).replace(/^0x/, "")) as Hex,
    delegation: child,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(CID),
  });
  const childSigned: Delegation = { ...child, signature: childSig };

  const leaf = createDelegation({
    environment: env,
    from: agent2.address,
    to: C.targetAddress,
    parentDelegation: childSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: USDC, maxAmount: cap },
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: ("0x" + (process.env.AGENT2_PK as string).replace(/^0x/, "")) as Hex,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(CID),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  const executions: WireExecution[] = [
    erc20TransferExecution(USDC, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(USDC, merchant.address, workAtoms),
  ];
  const permissionContext = [
    wireDelegation(leafSigned),
    wireDelegation(childSigned),
    wireDelegation(rootSigned),
  ];
  return { permissionContext, executions, user, merchant, agent1, agent2 };
}

// OR-group: root carries LogicalOrWrapper(AC pin feeCollector | AC pin MERCHANT).
// The wrapper's selected group is checked against the FEE execution on a real send
// (live behavior, differs from probe-8's estimate-only model). Select group 0
// (feeCollector pin) with a single fee execution; this is the accepted live shape
// proving the LogicalOrWrapperEnforcer executes correctly on a funded redemption.
// group: 0 = feeCollector, 1 = MERCHANT (both are independently safe pins).
async function composeOrGroup(feeAtoms: bigint, _workAtoms: bigint, opts: { workOnly?: boolean } = {}) {
  const env = envFor(CID);
  const acEnforcer = env.caveatEnforcers.AllowedCalldataEnforcer as Address;
  const { user, merchant, agent1 } = loadAccounts();
  const smartUser = await buildStateless7702(CID, user.address, user);
  const now = Math.floor(Date.now() / 1000) - 300;

  const acTerms = (v: Address) =>
    createAllowedCalldataTerms({ startIndex: 4, value: pad(v, { size: 32 }) }) as Hex;

  // group 0 = feeCollector, group 1 = MERCHANT
  const orTerms = createLogicalOrWrapperTerms({
    caveatGroups: [
      [{ enforcer: acEnforcer, terms: acTerms(FEE_COLLECTOR), args: "0x00" }],
      [{ enforcer: acEnforcer, terms: acTerms(merchant.address), args: "0x00" }],
    ] as any,
  }) as Hex;
  // select group 0 (feeCollector pin) — matched by the single fee execution
  const orArgs = createLogicalOrWrapperArgs({ groupIndex: 0n, caveatArgs: ["0x00"] }) as Hex;

  const periodCv = caveatBuilderFor(CID)
    .addCaveat("erc20PeriodTransfer", { tokenAddress: USDC, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
    .build();
  const { createCaveat } = await import("@metamask/smart-accounts-kit");
  const rootCaveats = [...periodCv, createCaveat(LOGICAL_OR_WRAPPER, orTerms, orArgs)];

  const root: Delegation = {
    delegate: agent1.address,
    delegator: user.address,
    authority: ROOT_AUTHORITY,
    caveats: rootCaveats as any,
    salt: freshSalt(),
    signature: "0x",
  };
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(CID) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  const leaf = createDelegation({
    environment: env,
    from: agent1.address,
    to: C.targetAddress,
    parentDelegation: rootSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: USDC, maxAmount: feeAtoms },
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: ("0x" + (process.env.AGENT1_PK as string).replace(/^0x/, "")) as Hex,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(CID),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  // single fee execution to feeCollector (matches group 0's pin)
  const fee = erc20TransferExecution(USDC, FEE_COLLECTOR, feeAtoms);
  const executions: WireExecution[] = [fee];

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  return { permissionContext, executions, user, merchant, agent1 };
}

// swap: leaf FunctionCall scope (allowedTargets [USDC, SwapRouter02] + allowedMethods
// [approve, exactInputSingle]). executions: approve(router, work) + exactInputSingle(USDC->WETH).
async function composeSwap(feeAtoms: bigint, swapAtoms: bigint) {
  const env = envFor(CID);
  const { user, agent1 } = loadAccounts();
  const smartUser = await buildStateless7702(CID, user.address, user);
  const now = Math.floor(Date.now() / 1000) - 300;

  // root: A_user -> A_agent1, period + timestamp + nonce
  const rootCaveats = caveatBuilderFor(CID)
    .addCaveat("erc20PeriodTransfer", { tokenAddress: USDC, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
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
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(CID) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  // leaf: FunctionCall scope (allowedTargets + allowedMethods)
  const leaf = createDelegation({
    environment: env,
    from: agent1.address,
    to: C.targetAddress,
    parentDelegation: rootSigned,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [USDC, SWAP_ROUTER_02],
      // include transfer() so the mandatory fee leg (USDC.transfer to feeCollector)
      // also passes the AllowedMethodsEnforcer (fee rides through the same leaf scope)
      selectors: [
        "transfer(address,uint256)",
        "approve(address,uint256)",
        "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
      ],
    } as any,
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: ("0x" + (process.env.AGENT1_PK as string).replace(/^0x/, "")) as Hex,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(CID),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  // executions: fee (to feeCollector, mandatory) + approve + exactInputSingle
  const routerAbi = [{
    name: "exactInputSingle", type: "function", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ]}],
    outputs: [{ name: "amountOut", type: "uint256" }],
  }] as const;
  const approveAbi = [{ name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

  const fee = erc20TransferExecution(USDC, FEE_COLLECTOR, feeAtoms);
  const approve: WireExecution = {
    target: USDC, value: "0",
    data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [SWAP_ROUTER_02, swapAtoms] }),
  };
  const swap: WireExecution = {
    target: SWAP_ROUTER_02, value: "0",
    data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{
      tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: user.address,
      amountIn: swapAtoms, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }] }),
  };
  const executions: WireExecution[] = [fee, approve, swap];
  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  return { permissionContext, executions, user, agent1 };
}

// ---------------------------------------------------------------------------
// estimate-then-send driver
// ---------------------------------------------------------------------------
async function estimateThenMaybeSend(
  label: string,
  compose: (feeAtoms: bigint) => Promise<{ permissionContext: any[]; executions: WireExecution[] }>,
  authMode: "withAuth" | "noAuth",
  doSend: boolean,
) {
  // minFee = 0.01 USDC = 10000 atoms. Use exactly minFee for fee.
  const feeAtoms = usdc(0.01);
  const { user } = loadAccounts();

  const built = await compose(feeAtoms);
  const auth = authMode === "withAuth" ? [await userAuth(user)] : undefined;

  console.log(`\n>>> ${label}: ESTIMATE (auth=${authMode})`);
  const est = await estimate(CID, [{ permissionContext: built.permissionContext, executions: built.executions }], auth);
  const pe = parseEstimate(est);
  console.log(`  http=${pe.http} success=${pe.success} requiredPaymentAmount=${pe.requiredPaymentAmount}`);
  if (!pe.success) {
    console.log(`  estimate raw:`, pe.raw.slice(0, 600));
    return { est: pe, sent: null };
  }
  console.log(`  fullResult keys:`, Object.keys(pe.fullResult || {}));
  console.log(`  context present:`, !!pe.context, "len", pe.context ? String(pe.context).length : 0);

  if (!doSend) {
    console.log(`  (estimate-only; not sending)`);
    return { est: pe, sent: null };
  }

  // SEND IMMEDIATELY with the estimate's context
  console.log(`>>> ${label}: SEND (context expires ~45s)`);
  const sres = await send(
    [{ permissionContext: built.permissionContext, executions: built.executions }],
    auth,
    pe.context,
  );
  console.log(`  send http=${sres.httpStatus}`);
  console.log(`  send raw:`, sres.raw.slice(0, 800));
  const reqId = sres.parsed?.result;
  if (typeof reqId === "string" && reqId.startsWith("0x")) {
    const final = await pollStatus(reqId);
    return { est: pe, sent: sres, reqId, final };
  }
  return { est: pe, sent: sres };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const step = process.argv[2] || "snap";

if (step === "snap") {
  await printSnap("snapshot");
} else if (step === "step1") {
  await printSnap("before step1");
  await estimateThenMaybeSend("STEP1 chain-2 estimate", (f) => composeChain2(f, usdc(0.01)), "withAuth", false);
} else if (step === "send1") {
  await printSnap("before SEND #1");
  const r = await estimateThenMaybeSend("SEND#1 chain-2", (f) => composeChain2(f, usdc(0.01)), "withAuth", true);
  console.log("\nSEND#1 result object:", JSON.stringify(r.sent?.parsed ?? r.sent, null, 2));
} else if (step === "send2") {
  await printSnap("before SEND #2");
  const r = await estimateThenMaybeSend("SEND#2 chain-3 A2A", (f) => composeChain3(f, usdc(0.01)), "noAuth", true);
  console.log("\nSEND#2 result object:", JSON.stringify(r.sent?.parsed ?? r.sent, null, 2));
} else if (step === "send3") {
  await printSnap("before SEND #3");
  const r = await estimateThenMaybeSend("SEND#3 OR-group", (f) => composeOrGroup(f, usdc(0.01)), "noAuth", true);
  console.log("\nSEND#3 result object:", JSON.stringify(r.sent?.parsed ?? r.sent, null, 2));
} else if (step === "send3-workonly") {
  await printSnap("before SEND #3 (work-only retry)");
  const r = await estimateThenMaybeSend("SEND#3 OR-group work-only", (f) => composeOrGroup(f, usdc(0.01), { workOnly: true }), "noAuth", true);
  console.log("\nSEND#3-workonly result:", JSON.stringify(r.sent?.parsed ?? r.sent, null, 2));
} else if (step === "send4") {
  await printSnap("before SEND #4");
  const r = await estimateThenMaybeSend("SEND#4 swap", (f) => composeSwap(f, usdc(0.05)), "noAuth", true);
  console.log("\nSEND#4 result object:", JSON.stringify(r.sent?.parsed ?? r.sent, null, 2));
} else if (step === "est2") {
  await estimateThenMaybeSend("EST chain-3", (f) => composeChain3(f, usdc(0.01)), "noAuth", false);
} else if (step === "est3") {
  await estimateThenMaybeSend("EST OR-group", (f) => composeOrGroup(f, usdc(0.01)), "noAuth", false);
} else if (step === "est4") {
  await estimateThenMaybeSend("EST swap", (f) => composeSwap(f, usdc(0.05)), "noAuth", false);
} else {
  console.log("unknown step:", step);
}
