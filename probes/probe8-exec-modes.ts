// Probe 8: EXECUTION-COUNT vs REDEMPTION-MODE mapping.
//
// Flagged build risk: AllowedCalldataEnforcer is onlySingleCallTypeMode;
// LogicalOrWrapperEnforcer.beforeHook is onlyDefaultExecutionMode. We need to know
// how the 1Shot relayer maps the `executions[]` array into redemption mode(s):
//   - If it batches BOTH executions into ONE batch-mode redemption, single-call-mode
//     enforcers (AllowedCalldata) and onlyDefaultExecutionMode hooks (OR-wrapper) REVERT
//     with a mode error.
//   - If it issues per-execution SINGLE_DEFAULT redemptions, each execution is checked
//     against the (whole) caveat stack independently.
//
// Chain-2 Plan A setup: root A_user(7702) -> A_agent(bare EOA), leaf A_agent -> target.
// Root carries an AllowedCalldataEnforcer pinning transfer() recipient to MERCHANT
// (8a/8c/8d) or an OR-wrapper of two recipient pins (8b).
//
// MERCHANT is a FIXED address so the pin is deterministic across variants.

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

const LOGICAL_OR_WRAPPER_ENFORCER =
  "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c" as `0x${string}`;
// Fixed merchant address (the pin target for the "work" leg).
const MERCHANT = "0xc29909c5e45f0c076830e02e6a36b5f3360743ed" as `0x${string}`;

type Variant = "8a" | "8b" | "8c" | "8d" | "8e" | "8f" | "8g";

// classify the estimate response into a coarse bucket for the matrix
export function classify(raw: string): string {
  if (/No valid payments to the feeAddress/i.test(raw)) return "REJECT (no-fee)";
  if (/at least the chain minimum fee/i.test(raw)) return "REJECT (sub-minFee)";
  if (/must be the relayer Target/i.test(raw)) return "REJECT (ordering)";
  if (/exactly one entry/i.test(raw)) return "REJECT (auth-count)";
  if (/AllowedCalldataEnforcer:invalid-calldata/i.test(raw)) return "SIM (pin reject)";
  if (/CaveatEnforcer:.*mode|single-call|default-execution|invalid-execution-mode|not-single-call/i.test(raw))
    return "SIM (mode reject)";
  if (/LogicalOrWrapperEnforcer:/i.test(raw)) return "SIM (wrapper reject)";
  if (/transfer amount exceeds balance|InsufficientBalance/i.test(raw)) return "SIM (balance)";
  if (/ECDSAInvalidSignature|InvalidSignature/i.test(raw)) return "SIM (sig)";
  if (/InvalidAuthority/i.test(raw)) return "SIM (authority)";
  if (/revert|CALL_EXCEPTION|SimulationFailed/i.test(raw)) return "SIM (revert)";
  if (/"success"\s*:\s*true/i.test(raw)) return "SUCCESS";
  return "OTHER";
}

export async function run(cid: ChainId, variant: Variant) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  const acEnforcer = env.caveatEnforcers.AllowedCalldataEnforcer as `0x${string}`;
  console.log(`\n----- PROBE 8 ${c.name} (${cid}) variant=${variant} -----`);

  const user = freshKey();
  const agent = freshKey();
  const smartUser = await buildStateless7702(cid, user.address, user.account);
  const now = Math.floor(Date.now() / 1000) - 300;

  const feeAtoms = usdc(0.02);
  const payAtoms = usdc(1.0);

  // Build the root caveat stack: period + a recipient pin (plain or OR-wrapped).
  const period = caveatBuilderFor(cid)
    .addCaveat("erc20PeriodTransfer", {
      tokenAddress: c.usdc,
      periodAmount: usdc(50),
      periodDuration: 604800,
      startDate: now,
    })
    .build();

  let rootCaveats: any[];
  if (variant === "8b") {
    // OR-wrapper: group0 pins feeCollector, group1 pins MERCHANT. Per-redemption args
    // select ONE group; we select group1 (MERCHANT) since work goes to MERCHANT.
    const acTerms = (v: `0x${string}`) =>
      createAllowedCalldataTerms({ startIndex: 4, value: pad(v, { size: 32 }) }) as `0x${string}`;
    const orTerms = createLogicalOrWrapperTerms({
      caveatGroups: [
        [{ enforcer: acEnforcer, terms: acTerms(FEE_COLLECTOR), args: "0x00" }], // group 0
        [{ enforcer: acEnforcer, terms: acTerms(MERCHANT), args: "0x00" }], // group 1
      ] as any,
    }) as `0x${string}`;
    const orArgs = createLogicalOrWrapperArgs({ groupIndex: 1n, caveatArgs: ["0x00"] }) as `0x${string}`;
    rootCaveats = [...period, createCaveat(LOGICAL_OR_WRAPPER_ENFORCER, orTerms, orArgs)];
  } else {
    // Plain AllowedCalldata pin: transfer() recipient (word at byte 4) == pinTarget.
    //  8a -> pin MERCHANT (collides with the fee leg to feeCollector).
    //  8c -> pin feeCollector (single fee execution satisfies it: clean SIM baseline).
    //  8d -> pin MERCHANT (single work exec, NO fee: tests fee requirement).
    //  8e -> pin feeCollector + [fee->feeCollector, work->MERCHANT]: the DECISIVE
    //        batch-vs-single discriminator. If BATCH mode, single-call-only
    //        AllowedCalldata throws a MODE error; if per-execution SINGLE_DEFAULT,
    //        the work leg fails the feeCollector pin with invalid-calldata.
    //  8f -> pin MERCHANT + [work->MERCHANT, fee->feeCollector] (ORDER FLIPPED): if the
    //        root pin only governs execution[0], the work leg (slot 0) satisfies the
    //        MERCHANT pin and the fee (slot 1) is unchecked -> SIM(balance). If the pin
    //        governs every execution, the fee leg fails invalid-calldata. Decides whether
    //        the root caveat is per-execution-all or first-execution-only.
    //  8g -> pin feeCollector + [fee->feeCollector, work->MERCHANT, work2->MERCHANT]
    //        (THREE execs): if only execution[0] is pin-checked -> SIM(balance); also
    //        tests whether >2 executions are accepted at all and whether a single-call
    //        enforcer ever sees a batch-mode error.
    const pinTarget =
      variant === "8c" || variant === "8e" || variant === "8g" ? FEE_COLLECTOR : MERCHANT;
    rootCaveats = caveatBuilderFor(cid)
      .addCaveat("erc20PeriodTransfer", {
        tokenAddress: c.usdc,
        periodAmount: usdc(50),
        periodDuration: 604800,
        startDate: now,
      })
      .addCaveat("allowedCalldata", { startIndex: 4, value: pad(pinTarget, { size: 32 }) })
      .build();
  }

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

  // leaf: A_agent -> target, Erc20TransferAmount cap
  const leaf = createDelegation({
    environment: env,
    from: agent.address,
    to: c.targetAddress,
    parentDelegation: rootSigned,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: feeAtoms + payAtoms },
    salt: freshSalt(),
  });
  const leafSig = await signDelegation({
    privateKey: agent.pk,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  // executions per variant
  const feeExec = erc20TransferExecution(c.usdc, FEE_COLLECTOR, feeAtoms);
  const workExec = erc20TransferExecution(c.usdc, MERCHANT, payAtoms);
  let executions: WireExecution[];
  if (variant === "8a" || variant === "8b" || variant === "8e") {
    executions = [feeExec, workExec]; // fee(feeCollector) + work(MERCHANT)
  } else if (variant === "8f") {
    executions = [workExec, feeExec]; // ORDER FLIPPED: work(MERCHANT) first, fee second
  } else if (variant === "8g") {
    // THREE execs: fee(slot0) + two work legs; pin == feeCollector governs slot0 only
    executions = [feeExec, workExec, erc20TransferExecution(c.usdc, MERCHANT, payAtoms)];
  } else if (variant === "8c") {
    // control: SINGLE fee execution, pin == feeCollector -> satisfied -> SIM baseline
    executions = [feeExec];
  } else {
    // 8d: single work exec, NO fee transfer at all
    executions = [workExec];
  }

  const a = await sign7702Auth(cid, user.account);
  const authEntry = { chainId: a.chainId, address: a.address, nonce: a.nonce, yParity: a.yParity, r: a.r, s: a.s };

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  const r = await estimate(cid, [{ permissionContext, executions }], [authEntry]);
  const verdict = classify(r.raw);
  console.log(`[p8:${variant}] verdict=${verdict} http=${r.httpStatus}\n     raw=`, r.raw.slice(0, 400));
  return { variant, verdict, raw: r.raw };
}

export async function runAll(cid: ChainId) {
  console.log(`\n========== PROBE 8 EXEC-MODES on ${CHAINS[cid].name} (${cid}) ==========`);
  const out: any[] = [];
  for (const v of ["8a", "8b", "8c", "8d", "8e", "8f", "8g"] as Variant[]) {
    try {
      out.push(await run(cid, v));
    } catch (e: any) {
      console.log(`[p8:${v}] LOCAL-ERROR: ${e.message?.slice(0, 200)}`);
      out.push({ variant: v, verdict: "LOCAL-ERROR", raw: e.message });
    }
  }
  return out;
}

if (import.meta.main) {
  await runAll(84532);
  await runAll(8453);
}
