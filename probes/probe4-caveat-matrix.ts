// Probe 4: CAVEAT STACK MATRIX.
// Chain-2 (Plan A): root A_user(7702) -> A_agent(bare EOA), leaf A_agent -> targetAddress.
// Vary the ROOT caveat stack one row at a time (keep leaf = Erc20TransferAmount),
// EXCEPT rows g/i which change the LEAF scope. authorizationList=[A_user auth].
//
// Verdict per row: "sim" (accepted to on-chain simulation; balance/revert error) vs
// "reject-4209" (UnsupportedCapability / validation rejection) vs other.

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
  erc20ApproveExecution,
  usdc,
  sign7702Auth,
  estimate,
  createCaveat,
  ScopeType,
  type ChainId,
  type Delegation,
  type WireExecution,
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

const ZERO_NONCE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// LogicalOrWrapperEnforcer IS deployed (delegation-framework v1.3.0, CREATE2 deterministic)
// at the SAME address on Base mainnet + Base Sepolia. SAK 1.6.0 getSmartAccountsEnvironment
// just omits it from caveatEnforcers, so we supply it manually. Verified via eth_getCode
// (3836 bytes) on both chains, 2026-06-05.
const LOGICAL_OR_WRAPPER_ENFORCER =
  "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c" as `0x${string}`;
const OR_MERCHANT_0 =
  "0xc29909c5e45f0c076830e02e6a36b5f3360743ed" as `0x${string}`;

// Uniswap v3 SwapRouter02 on Base Sepolia (well-known); used as an allowedTargets addr.
const ROUTER_BASE_SEPOLIA = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as `0x${string}`;
const TRANSFER_SELECTOR = "0xa9059cbb"; // erc20 transfer
const APPROVE_SELECTOR = "0x095ea7b3"; // erc20 approve

type Row = {
  id: string;
  desc: string;
  // returns {rootCaveats?, leafScope, leafExecutions}
  build: (cid: ChainId, agentAddr: `0x${string}`) => {
    rootCaveats: any[];
    leafScope?: any;
    leafCaveatsOverride?: any[]; // for FunctionCall / exactCalldata leaf
    leafIsFunctionCall?: boolean;
    executions: WireExecution[];
  };
};

function periodCaveat(cid: ChainId, c: (typeof CHAINS)[ChainId], now: number) {
  return caveatBuilderFor(cid)
    .addCaveat("erc20PeriodTransfer", {
      tokenAddress: c.usdc,
      periodAmount: usdc(50),
      periodDuration: 604800,
      startDate: now,
    })
    .build();
}

const ROWS: Row[] = [
  {
    id: "4a",
    desc: "erc20PeriodTransfer alone",
    build: (cid, _agent) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      return {
        rootCaveats: periodCaveat(cid, c, now),
        leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) },
        executions: txExecutions(cid),
      };
    },
  },
  {
    id: "4b",
    desc: "+ timestamp",
    build: (cid) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      const rootCaveats = caveatBuilderFor(cid)
        .addCaveat("erc20PeriodTransfer", { tokenAddress: c.usdc, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
        .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
        .build();
      return { rootCaveats, leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) }, executions: txExecutions(cid) };
    },
  },
  {
    id: "4c",
    desc: "+ nonce (NonceEnforcer)",
    build: (cid) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      const rootCaveats = caveatBuilderFor(cid)
        .addCaveat("erc20PeriodTransfer", { tokenAddress: c.usdc, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
        .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
        .addCaveat("nonce", { nonce: ZERO_NONCE })
        .build();
      return { rootCaveats, leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) }, executions: txExecutions(cid) };
    },
  },
  {
    id: "4d",
    desc: "+ limitedCalls(1)",
    build: (cid) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      const rootCaveats = caveatBuilderFor(cid)
        .addCaveat("erc20PeriodTransfer", { tokenAddress: c.usdc, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
        .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
        .addCaveat("nonce", { nonce: ZERO_NONCE })
        .addCaveat("limitedCalls", { limit: 1 })
        .build();
      return { rootCaveats, leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) }, executions: txExecutions(cid) };
    },
  },
  {
    id: "4e",
    desc: "+ allowedCalldata pinning transfer recipient (merchant lock); SINGLE merchant-only execution to satisfy the pin uniformly",
    build: (cid) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      // NOTE: AllowedCalldataEnforcer checks EVERY governed execution. The fee
      // transfer goes to feeCollector, so a merchant-pin breaks it. To show a
      // clean pass we pin to feeCollector and send only the fee execution; the
      // merchant-lock learning is recorded in RESULTS.md.
      const recipientPin = pad(FEE_COLLECTOR, { size: 32 });
      const rootCaveats = caveatBuilderFor(cid)
        .addCaveat("erc20PeriodTransfer", { tokenAddress: c.usdc, periodAmount: usdc(50), periodDuration: 604800, startDate: now })
        .addCaveat("allowedCalldata", { startIndex: 4, value: recipientPin })
        .build();
      return {
        rootCaveats,
        leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) },
        executions: [erc20TransferExecution(c.usdc, FEE_COLLECTOR, usdc(0.02))],
      };
    },
  },
  {
    id: "4f",
    desc: "logicalOrWrapper wrapping two allowedCalldata recipient pins (OR-group), real enforcer 0xE130...B46c, redeem groupIndex=0",
    build: (cid) => {
      const c = CHAINS[cid];
      const env = envFor(cid);
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      const acEnforcer = env.caveatEnforcers.AllowedCalldataEnforcer as `0x${string}`;
      // Two recipient pins as an OR-group. AllowedCalldataEnforcer is single-call
      // mode, and the relayer mandates a fee transfer to feeCollector. We make the
      // SINGLE redeemed execution the fee transfer and set group 0's pin to
      // feeCollector, so: single-call mode (sub-enforcer happy) + fee present
      // (relayer happy) + OR selects group 0 -> AllowedCalldata verifies recipient
      // == feeCollector -> the OR-wrapper runs and passes on-chain, leaving only
      // the balance failure. group 1 pins a different merchant (the OR alternative).
      const g0 = pad(FEE_COLLECTOR, { size: 32 });
      const g1 = pad(OR_MERCHANT_0, { size: 32 });
      const acTerms = (v: `0x${string}`) =>
        createAllowedCalldataTerms({ startIndex: 4, value: v }) as `0x${string}`;
      // SDK encoder for the CaveatGroup[] terms (0x00 inner args; enforcer ignores them).
      const orTerms = createLogicalOrWrapperTerms({
        caveatGroups: [
          [{ enforcer: acEnforcer, terms: acTerms(g0), args: "0x00" }],
          [{ enforcer: acEnforcer, terms: acTerms(g1), args: "0x00" }],
        ] as any,
      }) as `0x${string}`;
      // Per-redemption args select group 0; one sub-caveat -> one (empty) caveatArg.
      const orArgs = createLogicalOrWrapperArgs({ groupIndex: 0n, caveatArgs: ["0x00"] }) as `0x${string}`;
      const orCaveat = createCaveat(LOGICAL_OR_WRAPPER_ENFORCER, orTerms, orArgs);
      const rootCaveats = [...periodCaveat(cid, c, now), orCaveat];
      return {
        rootCaveats,
        leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) },
        executions: [erc20TransferExecution(c.usdc, FEE_COLLECTOR, usdc(0.02))],
      };
    },
  },
  {
    id: "4g",
    desc: "FunctionCall scope leaf (approve with allowedTargets+allowedMethods)",
    build: (cid, _agent) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      // leaf is FunctionCall: allowedTargets=[usdc] + allowedMethods=[approve]
      // allow BOTH transfer (fee) and approve (work) on USDC so the fee execution
      // also passes the method whitelist.
      const leafCaveats = caveatBuilderFor(cid)
        .addCaveat("allowedTargets", { targets: [c.usdc] })
        .addCaveat("allowedMethods", { selectors: [APPROVE_SELECTOR, TRANSFER_SELECTOR] })
        .build();
      // fee transfer + an approve call (work execution)
      const executions = [
        erc20TransferExecution(c.usdc, FEE_COLLECTOR, usdc(0.02)),
        erc20ApproveExecution(c.usdc, "0xc29909c5e45f0c076830e02e6a36b5f3360743ed", usdc(1)),
      ];
      return {
        rootCaveats: periodCaveat(cid, c, now),
        leafCaveatsOverride: leafCaveats,
        leafIsFunctionCall: true,
        executions,
      };
    },
  },
  {
    id: "4h",
    desc: "swap-ish: allowedTargets(router)+allowedMethods+erc20BalanceChange guard",
    build: (cid) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      const rootCaveats = caveatBuilderFor(cid)
        .addCaveat("allowedTargets", { targets: [ROUTER_BASE_SEPOLIA, c.usdc] })
        .addCaveat("allowedMethods", { selectors: [APPROVE_SELECTOR, TRANSFER_SELECTOR] })
        .addCaveat("erc20BalanceChange", { tokenAddress: c.usdc, recipient: FEE_COLLECTOR, balance: usdc(0.01), changeType: 0 })
        .build();
      return { rootCaveats, leafScope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(1.02) }, executions: txExecutions(cid) };
    },
  },
  {
    id: "4i",
    desc: "exactCalldata leaf (single payment execution pinned exactly)",
    build: (cid) => {
      const c = CHAINS[cid];
      const now = Math.floor(Date.now() / 1000) - 300; // start 5min in past so period is active
      // ExactCalldataEnforcer pins ONE execution's calldata. With the mandatory
      // fee transfer present, a 2-execution batch would fail per-execution, so
      // we pin only the (single) merchant payment and let the fee ride as the
      // sole other execution -- but the enforcer applies to every execution, so
      // here we demonstrate the clean single-execution case: fee transfer pinned.
      const feeExec = erc20TransferExecution(c.usdc, FEE_COLLECTOR, usdc(0.02));
      const leafCaveats = caveatBuilderFor(cid)
        .addCaveat("exactCalldata", { calldata: feeExec.data })
        .build();
      return {
        rootCaveats: periodCaveat(cid, c, now),
        leafCaveatsOverride: leafCaveats,
        leafIsFunctionCall: true,
        executions: [feeExec],
      };
    },
  },
];

function txExecutions(cid: ChainId): WireExecution[] {
  const c = CHAINS[cid];
  const merchant = "0xc29909c5e45f0c076830e02e6a36b5f3360743ed" as `0x${string}`;
  return txToExecutions(cid, merchant);
}
function txToExecutions(cid: ChainId, merchant: `0x${string}`): WireExecution[] {
  const c = CHAINS[cid];
  return [
    erc20TransferExecution(c.usdc, FEE_COLLECTOR, usdc(0.02)),
    erc20TransferExecution(c.usdc, merchant, usdc(1)),
  ];
}

function classify(raw: string): string {
  if (/4209|UnsupportedCapability/i.test(raw)) return "REJECT-4209";
  if (/exceeds balance|InsufficientBalance|4205/i.test(raw)) return "SIM (balance)";
  if (/ECDSAInvalidSignature|InvalidSignature|4201/i.test(raw)) return "SIM (sig)";
  if (/InvalidAuthority/i.test(raw)) return "SIM (authority)";
  if (/revert|CALL_EXCEPTION|SimulationFailed|4211|missing revert/i.test(raw)) return "SIM (revert)";
  if (/"success":true/i.test(raw)) return "SUCCESS";
  return "OTHER";
}

export async function runRow(cid: ChainId, row: Row) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  const user = freshKey();
  const agent = freshKey();
  const smartUser = await buildStateless7702(cid, user.address, user.account);

  const spec = row.build(cid, agent.address);

  const root: Delegation = {
    delegate: agent.address,
    delegator: user.address,
    authority: ROOT_AUTHORITY,
    caveats: spec.rootCaveats as any,
    salt: freshSalt(),
    signature: "0x",
  };
  const rootSig = await smartUser.signDelegation({ delegation: root, chainId: Number(cid) });
  const rootSigned: Delegation = { ...root, signature: rootSig };

  let leaf: Delegation;
  if (spec.leafCaveatsOverride) {
    // build leaf as a child of root with explicit caveats (no scope)
    leaf = createDelegation({
      environment: env,
      from: agent.address,
      to: c.targetAddress,
      parentDelegation: rootSigned,
      caveats: spec.leafCaveatsOverride as any,
      salt: freshSalt(),
    } as any);
  } else {
    leaf = createDelegation({
      environment: env,
      from: agent.address,
      to: c.targetAddress,
      parentDelegation: rootSigned,
      scope: spec.leafScope,
      salt: freshSalt(),
    });
  }
  const leafSig = await signDelegation({
    privateKey: agent.pk,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  const a = await sign7702Auth(cid, user.account);
  const authEntry = { chainId: a.chainId, address: a.address, nonce: a.nonce, yParity: a.yParity, r: a.r, s: a.s };

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  const r = await estimate(cid, [{ permissionContext, executions: spec.executions }], [authEntry]);
  const verdict = classify(r.raw);
  console.log(`[${row.id}] ${row.desc}\n     verdict=${verdict} http=${r.httpStatus}\n     raw=${r.raw.slice(0, 300)}`);
  return { row: row.id, desc: row.desc, verdict, raw: r.raw };
}

export async function runMatrix(cid: ChainId) {
  console.log(`\n========== PROBE 4 CAVEAT MATRIX on ${CHAINS[cid].name} (${cid}) ==========`);
  const out: any[] = [];
  for (const row of ROWS) {
    try {
      out.push(await runRow(cid, row));
    } catch (e: any) {
      console.log(`[${row.id}] LOCAL-ERROR: ${e.message?.slice(0, 200)}`);
      out.push({ row: row.id, desc: row.desc, verdict: "LOCAL-ERROR", raw: e.message });
    }
  }
  return out;
}

if (import.meta.main) {
  await runMatrix(84532);
}
