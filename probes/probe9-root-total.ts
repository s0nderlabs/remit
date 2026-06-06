// Probe 9: ERC20TransferAmountEnforcer as a ROOT caveat (lifetime-total card).
//
// erc20TransferAmount is the natural LEAF scope, but it ALSO works as a root caveat:
// a lifetime cumulative ceiling on the whole sub-card tree (vs erc20PeriodTransfer,
// which is a rolling window). This probe confirms the relayer accepts it on the root.
//
// Chain-2 Plan A: root A_user(7702) -> A_agent(bare EOA), leaf A_agent -> target.
//
//   "total"  : root caveats = erc20TransferAmount(USDC, totalCap) + timestamp + nonce
//   "stacked": root caveats = erc20PeriodTransfer + erc20TransferAmount + timestamp + nonce
//              (period window AND lifetime ceiling composed together)
//
// Leaf scope = Erc20TransferAmount as usual. Expected: accepted-to-simulation (balance).

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

type Variant = "total" | "stacked";

export function classify(raw: string): string {
  if (/4209|UnsupportedCapability/i.test(raw)) return "REJECT-4209";
  if (/transfer amount exceeds balance|InsufficientBalance/i.test(raw)) return "SIM (balance)";
  if (/ERC20TransferAmountEnforcer:/i.test(raw)) return "SIM (transfer-amount reject)";
  if (/ERC20PeriodTransferEnforcer:/i.test(raw)) return "SIM (period reject)";
  if (/ECDSAInvalidSignature|InvalidSignature/i.test(raw)) return "SIM (sig)";
  if (/InvalidAuthority/i.test(raw)) return "SIM (authority)";
  if (/revert|CALL_EXCEPTION|SimulationFailed/i.test(raw)) return "SIM (revert)";
  if (/"success"\s*:\s*true/i.test(raw)) return "SUCCESS";
  return "OTHER";
}

export async function run(cid: ChainId, variant: Variant) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  console.log(`\n----- PROBE 9 ${c.name} (${cid}) variant=${variant} -----`);

  const user = freshKey();
  const agent = freshKey();
  const smartUser = await buildStateless7702(cid, user.address, user.account);
  const now = Math.floor(Date.now() / 1000) - 300;

  const feeAtoms = usdc(0.02);
  const payAtoms = usdc(1.0);
  const totalCap = usdc(100); // lifetime ceiling

  let rootCaveats: any[];
  if (variant === "total") {
    rootCaveats = caveatBuilderFor(cid)
      .addCaveat("erc20TransferAmount", { tokenAddress: c.usdc, maxAmount: totalCap })
      .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
      .addCaveat("nonce", { nonce: ZERO_NONCE })
      .build();
  } else {
    rootCaveats = caveatBuilderFor(cid)
      .addCaveat("erc20PeriodTransfer", {
        tokenAddress: c.usdc,
        periodAmount: usdc(50),
        periodDuration: 604800,
        startDate: now,
      })
      .addCaveat("erc20TransferAmount", { tokenAddress: c.usdc, maxAmount: totalCap })
      .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: now + 7 * 86400 })
      .addCaveat("nonce", { nonce: ZERO_NONCE })
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

  const merchant = freshKey().address;
  const executions = [
    erc20TransferExecution(c.usdc, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(c.usdc, merchant, payAtoms),
  ];

  const a = await sign7702Auth(cid, user.account);
  const authEntry = { chainId: a.chainId, address: a.address, nonce: a.nonce, yParity: a.yParity, r: a.r, s: a.s };

  const permissionContext = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  const r = await estimate(cid, [{ permissionContext, executions }], [authEntry]);
  const verdict = classify(r.raw);
  console.log(`[p9:${variant}] verdict=${verdict} http=${r.httpStatus}\n     raw=`, r.raw.slice(0, 400));
  return { variant, verdict, raw: r.raw };
}

export async function runAll(cid: ChainId) {
  console.log(`\n========== PROBE 9 ROOT-TOTAL on ${CHAINS[cid].name} (${cid}) ==========`);
  const out: any[] = [];
  for (const v of ["total", "stacked"] as Variant[]) {
    try {
      out.push(await run(cid, v));
    } catch (e: any) {
      console.log(`[p9:${v}] LOCAL-ERROR: ${e.message?.slice(0, 200)}`);
      out.push({ variant: v, verdict: "LOCAL-ERROR", raw: e.message });
    }
  }
  return out;
}

if (import.meta.main) {
  await runAll(84532);
  await runAll(8453);
}
