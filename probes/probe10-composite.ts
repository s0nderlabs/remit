// Probe 10 (build-day-1): COMPOSITE pay+swap OR-group root.
// ESTIMATE-ONLY. Never calls relayer_send7710Transaction.
//
// Goal: ONE remit "card" (one root ERC-7710 delegation) that serves BOTH
//   (a) capped USDC pay  AND  (b) scoped swap on SwapRouter02.
// Phase B proved a transfer-shaped erc20PeriodTransfer ROOT cap REJECTS swap legs
// (ERC20PeriodTransferEnforcer:invalid-method). Candidate fix: wrap the two modes as
// OR alternatives so the redeemer picks the branch per redemption:
//
//   root caveats = [ NonceEnforcer, TimestampEnforcer,
//                    LogicalOrWrapper( groupA | groupB ) ]
//     groupA (PAY)  = [ ERC20PeriodTransferEnforcer (USDC cap) ]   -> transfer-shaped
//     groupB (SWAP) = [ AllowedTargetsEnforcer([USDC, SwapRouter02]),
//                       AllowedMethodsEnforcer([transfer, approve, exactInputSingle]) ]
//
// Per-redemption args select groupIndex 0 (pay) or 1 (swap), caveatArgs.length == group size.
//
// MATRIX (each = one relayer_estimate7710Transaction on mainnet 8453; A_user funded so a
// satisfied request reaches `success:true`):
//   1 PAY-viaA  : select group 0, execs [work transfer, fee transfer]      -> expect success:true
//   2 SWAP-viaB : select group 1, execs [approve, exactInputSingle, fee]   -> expect success or mode/method signal
//   3 SWAP-feeIsolate : if (2) fails, single-exec variants to localize the failure
//        3a SWAP-feeonly : group 1, execs [fee transfer only]
//        3b SWAP-approveonly : group 1, execs [approve only]
//        3c SWAP-swaponly : group 1, execs [exactInputSingle only]
//   4 NEG       : select group 0 (pay) but feed swap-shaped execs -> expect
//                 ERC20PeriodTransferEnforcer:invalid-method (proves groups actually gate)
//
// Build rules honored: leaf-first permissionContext, leaf.delegate == relayer targetAddress,
// mandatory fee >= minFee (0.01 USDC = 10000 atoms) to feeCollector, exactly-one-or-zero auth
// (A_user already 7702-coded on mainnet from Phase B, so NO authorizationList needed).

import {
  createPublicClient,
  http,
  encodeFunctionData,
  pad,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  CHAINS,
  FEE_COLLECTOR,
  freshSalt,
  buildStateless7702,
  envFor,
  caveatBuilderFor,
  wireDelegation,
  erc20TransferExecution,
  usdc,
  estimate,
  createCaveat,
  type WireExecution,
  type ChainId,
  type Delegation,
} from "./lib";
import {
  createDelegation,
  signDelegation,
  ROOT_AUTHORITY,
  ScopeType,
} from "@metamask/smart-accounts-kit";
import {
  createLogicalOrWrapperTerms,
  createLogicalOrWrapperArgs,
} from "@metamask/delegation-core";

const CID = 8453 as const satisfies ChainId;
const C = CHAINS[CID];
const USDC = C.usdc;
const LOGICAL_OR_WRAPPER =
  "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c" as Address;
const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (source .env.funded and .env.phaseb)`);
  return v;
}

function loadAccounts() {
  const user = privateKeyToAccount(reqEnv("FUNDED_USER_PK") as Hex);
  const agent1 = privateKeyToAccount(reqEnv("AGENT1_PK") as Hex);
  const merchant = privateKeyToAccount(reqEnv("MERCHANT_PK") as Hex);
  return { user, agent1, merchant };
}

// ---- abi fragments for swap legs ----
const approveAbi = [{
  name: "approve", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;
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

function approveExec(spender: Address, amount: bigint): WireExecution {
  return {
    target: USDC, value: "0",
    data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [spender, amount] }),
  };
}
function swapExec(amountIn: bigint, recipient: Address): WireExecution {
  return {
    target: SWAP_ROUTER_02, value: "0",
    data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{
      tokenIn: USDC, tokenOut: WETH, fee: 500, recipient,
      amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    }] }),
  };
}

// ---------------------------------------------------------------------------
// Build the COMPOSITE root once: [nonce, timestamp, OR(groupA | groupB)].
// groupA = erc20PeriodTransfer (PAY, transfer-shaped). groupB = allowedTargets + allowedMethods (SWAP).
// The selected group is supplied per-redemption via the wrapper args (groupIndex + caveatArgs).
// caveatArgs length MUST equal the selected group's caveat count (groupA=1, groupB=2).
// ---------------------------------------------------------------------------
function buildCompositeRootCaveats(now: number) {
  const env = envFor(CID);
  const AT = env.caveatEnforcers.AllowedTargetsEnforcer as Address;
  const AM = env.caveatEnforcers.AllowedMethodsEnforcer as Address;
  const ERC20_PERIOD = env.caveatEnforcers.ERC20PeriodTransferEnforcer as Address;

  // -- groupA sub-caveat: erc20PeriodTransfer terms via the kit builder (1 caveat) --
  const payCv = caveatBuilderFor(CID)
    .addCaveat("erc20PeriodTransfer", {
      tokenAddress: USDC, periodAmount: usdc(50), periodDuration: 604800, startDate: now,
    })
    .build();
  if (payCv.length !== 1) throw new Error("expected 1 erc20PeriodTransfer caveat");
  const periodTerms = payCv[0].terms as Hex;
  if (payCv[0].enforcer.toLowerCase() !== ERC20_PERIOD.toLowerCase()) {
    throw new Error(`period enforcer mismatch ${payCv[0].enforcer} != ${ERC20_PERIOD}`);
  }

  // -- groupB sub-caveats: allowedTargets + allowedMethods terms via the kit builder (2 caveats) --
  // allowedTargets [USDC, SwapRouter02]; allowedMethods MUST include transfer() so the mandatory
  // fee leg (USDC.transfer to feeCollector) passes when groupB is the selected branch.
  const swapCv = caveatBuilderFor(CID)
    .addCaveat("allowedTargets", { targets: [USDC, SWAP_ROUTER_02] })
    .addCaveat("allowedMethods", {
      selectors: [
        "transfer(address,uint256)",
        "approve(address,uint256)",
        "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
      ],
    })
    .build();
  if (swapCv.length !== 2) throw new Error("expected 2 swap caveats (targets+methods)");
  const targetsCaveat = swapCv.find((c) => c.enforcer.toLowerCase() === AT.toLowerCase());
  const methodsCaveat = swapCv.find((c) => c.enforcer.toLowerCase() === AM.toLowerCase());
  if (!targetsCaveat || !methodsCaveat) throw new Error("missing targets/methods enforcer in env");

  // -- OR-wrapper terms: group 0 = PAY (1 caveat), group 1 = SWAP (2 caveats) --
  const orTerms = createLogicalOrWrapperTerms({
    caveatGroups: [
      [{ enforcer: ERC20_PERIOD, terms: periodTerms, args: "0x00" }],
      [
        { enforcer: AT, terms: targetsCaveat.terms as Hex, args: "0x00" },
        { enforcer: AM, terms: methodsCaveat.terms as Hex, args: "0x00" },
      ],
    ] as any,
  }) as Hex;

  // nonce + timestamp ride alongside the wrapper (cascade-revoke + expiry, both groups)
  const nonceTs = caveatBuilderFor(CID)
    .addCaveat("nonce", { nonce: "0x0000000000000000000000000000000000000000000000000000000000000000" })
    .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
    .build();

  return { orTerms, nonceTs, AT, AM, ERC20_PERIOD };
}

// per-redemption wrapper args: select a group, caveatArgs.length == group size.
function orArgsFor(groupIndex: bigint, size: number): Hex {
  return createLogicalOrWrapperArgs({
    groupIndex,
    caveatArgs: Array(size).fill("0x00"),
  }) as Hex;
}

// ---------------------------------------------------------------------------
// Compose a full request: signed root (composite) + signed leaf + executions.
// The leaf scope differs by mode: PAY leaf = Erc20TransferAmount (transfer-only),
// SWAP leaf = FunctionCall (targets+methods) so the leaf doesn't itself reject swap calls.
// ---------------------------------------------------------------------------
async function composeComposite(opts: {
  selectGroup: bigint;          // 0 = pay, 1 = swap
  groupSize: number;            // caveatArgs length (group 0 -> 1, group 1 -> 2)
  leafMode: "pay" | "swap";
  executions: WireExecution[];
}) {
  const env = envFor(CID);
  const { user, agent1 } = loadAccounts();
  const smartUser = await buildStateless7702(CID, user.address, user as any);
  const now = Math.floor(Date.now() / 1000) - 300;

  const { orTerms, nonceTs } = buildCompositeRootCaveats(now);
  const orArgs = orArgsFor(opts.selectGroup, opts.groupSize);
  const orCaveat = createCaveat(LOGICAL_OR_WRAPPER, orTerms, orArgs);
  // root caveats: [nonce, timestamp, OR-wrapper]
  const rootCaveats = [...nonceTs, orCaveat];

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

  // leaf scope by mode
  const leafScope = opts.leafMode === "pay"
    ? { type: ScopeType.Erc20TransferAmount, tokenAddress: USDC, maxAmount: usdc(1.0) }
    : {
        type: ScopeType.FunctionCall,
        targets: [USDC, SWAP_ROUTER_02],
        selectors: [
          "transfer(address,uint256)",
          "approve(address,uint256)",
          "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
        ],
      };

  const leaf = createDelegation({
    environment: env,
    from: agent1.address,
    to: C.targetAddress,
    parentDelegation: rootSigned,
    scope: leafScope as any,
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: reqEnv("AGENT1_PK") as Hex,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(CID),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  return { permissionContext, executions: opts.executions };
}

function parseEst(r: { httpStatus: number; raw: string; parsed: any }) {
  const result = r.parsed?.result;
  const err = r.parsed?.error;
  // estimate failure strings come back inside result (success:false, error string) OR as rpc error
  const errStr = result?.error ?? err?.message ?? err ?? null;
  return {
    http: r.httpStatus,
    success: result?.success ?? false,
    requiredPaymentAmount: result?.requiredPaymentAmount ?? null,
    errStr: typeof errStr === "string" ? errStr : errStr ? JSON.stringify(errStr) : null,
    raw: r.raw,
  };
}

async function runEstimate(label: string, built: { permissionContext: any[]; executions: WireExecution[] }) {
  // A_user is already 7702-coded on mainnet (Phase B), so NO authorizationList.
  const est = await estimate(CID, [built], undefined);
  const pe = parseEst(est);
  const signal = pe.success ? "success:true" : (pe.errStr ?? pe.raw.slice(0, 300));
  console.log(`\n[${label}] http=${pe.http} success=${pe.success} required=${pe.requiredPaymentAmount}`);
  console.log(`  signal: ${signal}`);
  return { label, ...pe, signal };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const { user } = loadAccounts();
  // sanity: confirm A_user is funded + coded so success:true is achievable
  const client = createPublicClient({ chain: base, transport: http(C.rpc) });
  const code = await client.getCode({ address: user.address });
  console.log(`A_user ${user.address} 7702-coded=${code && code !== "0x" ? "YES" : "NO"}`);

  const FEE = usdc(0.01);   // exactly minFee
  const WORK = usdc(0.01);  // pay work leg
  const SWAP_IN = usdc(0.05); // tiny swap amount

  const results: Array<ReturnType<typeof parseEst> & { label: string; signal: string }> = [];

  // ----- ROW 1: PAY via group A (select 0). execs [work transfer, fee transfer]. -----
  // Build rule from probe 8: WORK = executions[0], fee = executions[1]. Both transfer-shaped,
  // so the selected erc20PeriodTransfer group accepts both.
  {
    const { merchant } = loadAccounts();
    const execs: WireExecution[] = [
      erc20TransferExecution(USDC, merchant.address, WORK), // work slot 0
      erc20TransferExecution(USDC, FEE_COLLECTOR, FEE),     // fee  slot 1
    ];
    const built = await composeComposite({ selectGroup: 0n, groupSize: 1, leafMode: "pay", executions: execs });
    results.push(await runEstimate("ROW1 PAY-viaA (group0, work+fee)", built));
  }

  // ----- ROW 2: SWAP via group B (select 1). execs [approve, exactInputSingle, fee]. -----
  // groupB = allowedTargets[USDC,router] + allowedMethods[transfer,approve,exactInputSingle].
  // The fee leg (USDC.transfer) must pass groupB too -> transfer() is in allowedMethods, USDC in targets.
  {
    const execs: WireExecution[] = [
      approveExec(SWAP_ROUTER_02, SWAP_IN),       // approve slot 0
      swapExec(SWAP_IN, user.address),            // exactInputSingle slot 1 (recipient = delegator)
      erc20TransferExecution(USDC, FEE_COLLECTOR, FEE), // fee slot 2
    ];
    const built = await composeComposite({ selectGroup: 1n, groupSize: 2, leafMode: "swap", executions: execs });
    results.push(await runEstimate("ROW2 SWAP-viaB (group1, approve+swap+fee)", built));
  }

  // ----- ROW 3: isolate the swap failure (single-exec variants), only if ROW2 failed. -----
  const row2 = results[results.length - 1];
  if (!row2.success) {
    console.log("\n--- ROW2 failed; running ROW3 single-execution isolation ---");
    // 3a: fee-only under group 1 (does groupB accept the mandatory transfer leg?)
    {
      const execs: WireExecution[] = [erc20TransferExecution(USDC, FEE_COLLECTOR, FEE)];
      const built = await composeComposite({ selectGroup: 1n, groupSize: 2, leafMode: "swap", executions: execs });
      results.push(await runEstimate("ROW3a SWAP-feeonly (group1, fee only)", built));
    }
    // 3b: approve-only under group 1 (fee omitted -> expect mandatory-fee reject OR method signal)
    {
      const execs: WireExecution[] = [approveExec(SWAP_ROUTER_02, SWAP_IN)];
      const built = await composeComposite({ selectGroup: 1n, groupSize: 2, leafMode: "swap", executions: execs });
      results.push(await runEstimate("ROW3b SWAP-approveonly (group1, approve only, no fee)", built));
    }
    // 3c: approve + fee (drop the swap leg) -> isolate whether exactInputSingle is the failing call
    {
      const execs: WireExecution[] = [
        approveExec(SWAP_ROUTER_02, SWAP_IN),
        erc20TransferExecution(USDC, FEE_COLLECTOR, FEE),
      ];
      const built = await composeComposite({ selectGroup: 1n, groupSize: 2, leafMode: "swap", executions: execs });
      results.push(await runEstimate("ROW3c SWAP-approve+fee (group1, no exactInputSingle)", built));
    }
    // 3d: swap-only (exactInputSingle, no fee) -> isolate the swap call itself
    {
      const execs: WireExecution[] = [swapExec(SWAP_IN, user.address)];
      const built = await composeComposite({ selectGroup: 1n, groupSize: 2, leafMode: "swap", executions: execs });
      results.push(await runEstimate("ROW3d SWAP-swaponly (group1, exactInputSingle only, no fee)", built));
    }
  }

  // ----- ROW 4: NEGATIVE control. Select group 0 (PAY) but feed swap-shaped execs. -----
  // The pay group is erc20PeriodTransfer (transfer-only). approve/exactInputSingle are NOT
  // transfers -> expect ERC20PeriodTransferEnforcer:invalid-method, proving the OR groups gate.
  {
    const execs: WireExecution[] = [
      approveExec(SWAP_ROUTER_02, SWAP_IN),       // non-transfer slot 0
      swapExec(SWAP_IN, user.address),
      erc20TransferExecution(USDC, FEE_COLLECTOR, FEE),
    ];
    // leaf must allow these calls so the failure is attributable to the ROOT group, not the leaf
    const built = await composeComposite({ selectGroup: 0n, groupSize: 1, leafMode: "swap", executions: execs });
    results.push(await runEstimate("ROW4 NEG (select group0 PAY, swap-shaped execs)", built));
  }

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    console.log(`${r.label}\n   -> success=${r.success} | ${r.signal.slice(0, 160)}`);
  }
}

if (import.meta.main) {
  await main();
}
