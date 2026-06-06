// Probe 6 (supplemental): fee-execution requirement + sub-minFee discrimination.
// Confirms the relayer enforces a fee transfer to feeCollector >= minFee as the
// first execution (maps the 4200 InsufficientPayment path), and what happens
// when the fee is below minFee. Still UNFUNDED -> we read the validation, not a send.

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
  minFeeToAtoms,
  sign7702Auth,
  getFeeData,
  estimate,
  ScopeType,
  type ChainId,
  type Delegation,
} from "./lib";
import { createDelegation } from "@metamask/smart-accounts-kit";

type Variant = "noFee" | "subMinFee" | "okFee";

export async function run(cid: ChainId, variant: Variant) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  console.log(`\n----- PROBE 6 ${c.name} variant=${variant} -----`);

  const A = freshKey();
  const smartA = await buildStateless7702(cid, A.address, A.account);

  // read live minFee
  const fee = await getFeeData(cid, c.usdc);
  const minFee = JSON.parse(fee.raw).result.minFee as string;
  const minAtoms = minFeeToAtoms(minFee);

  const payAtoms = usdc(1);
  const built = createDelegation({
    environment: env,
    from: A.address,
    to: c.targetAddress,
    scope: { type: ScopeType.Erc20TransferAmount, tokenAddress: c.usdc, maxAmount: usdc(5) },
    salt: freshSalt(),
  });
  const sig = await smartA.signDelegation({ delegation: built, chainId: Number(cid) });
  const signed: Delegation = { ...built, signature: sig };

  const merchant = freshKey().address;
  let executions;
  if (variant === "noFee") {
    executions = [erc20TransferExecution(c.usdc, merchant, payAtoms)];
  } else if (variant === "subMinFee") {
    executions = [
      erc20TransferExecution(c.usdc, FEE_COLLECTOR, minAtoms / 2n),
      erc20TransferExecution(c.usdc, merchant, payAtoms),
    ];
  } else {
    executions = [
      erc20TransferExecution(c.usdc, FEE_COLLECTOR, minAtoms),
      erc20TransferExecution(c.usdc, merchant, payAtoms),
    ];
  }

  const a = await sign7702Auth(cid, A.account);
  const authEntry = { chainId: a.chainId, address: a.address, nonce: a.nonce, yParity: a.yParity, r: a.r, s: a.s };
  const r = await estimate(cid, [{ permissionContext: [wireDelegation(signed)], executions }], [authEntry]);
  console.log(`[p6] minFee=${minFee} (${minAtoms} atoms) http=${r.httpStatus} raw=`, r.raw.slice(0, 300));
  return r;
}

if (import.meta.main) {
  await run(84532, "noFee");
  await run(84532, "subMinFee");
  await run(84532, "okFee");
}
