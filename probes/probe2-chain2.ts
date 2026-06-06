// Probe 2: CHAIN LENGTH 2 (PLAN A).
// root: A_user -> A_agent (erc20PeriodTransfer 50 USDC/week + Timestamp expiry + Nonce)
// leaf: A_agent -> targetAddress (Erc20TransferAmount fee+payment)
// A_agent = BARE EOA (no auth included). authorizationList = [A_user auth].
// permissionContext = [leaf, root]  (also try [root, leaf]).
//
// Plan A question: does the relayer reject because the leaf delegator (A_agent)
// lacks 7702 code, or proceed to simulation/balance failure?

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

export async function runChain2(
  cid: ChainId,
  ordering: "leaf,root" | "root,leaf" = "leaf,root",
  opts: { agentAuth?: boolean; doubleAuth?: boolean } = {},
) {
  const c = CHAINS[cid];
  const env = envFor(cid);
  const tag = `agentAuth=${!!opts.agentAuth} doubleAuth=${!!opts.doubleAuth}`;
  console.log(
    `\n===== PROBE 2/3 CHAIN-2 on ${c.name} (${cid}) ordering=[${ordering}] ${tag} =====`,
  );

  const user = freshKey(); // A_user: 7702 smart account (root delegator)
  const agent = freshKey(); // A_agent: BARE EOA (leaf delegator)
  console.log("[p2] A_user (root delegator, 7702):", user.address);
  console.log("[p2] A_agent (leaf delegator, bare EOA):", agent.address);

  const smartUser = await buildStateless7702(cid, user.address, user.account);

  // ---- root: A_user -> A_agent, caveats: period + timestamp + nonce ----
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

  // Build root delegation struct directly (ROOT_AUTHORITY) so the caveat set is
  // exactly period+timestamp+nonce with no extra scope caveat appended.
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
  const rootSigned: Delegation = { ...root, signature: rootSig };

  // ---- leaf: A_agent -> targetAddress, scope Erc20TransferAmount (fee+pay) ----
  const feeAtoms = usdc(0.02);
  const payAtoms = usdc(1.0);
  const leaf: Delegation = createDelegation({
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
  const leafSig = await signDelegation({
    privateKey: agent.pk,
    delegation: leaf,
    delegationManager: env.DelegationManager as `0x${string}`,
    chainId: Number(cid),
  });
  const leafSigned: Delegation = { ...leaf, signature: leafSig };

  // executions
  const merchant = freshKey().address;
  const executions = [
    erc20TransferExecution(c.usdc, FEE_COLLECTOR, feeAtoms),
    erc20TransferExecution(c.usdc, merchant, payAtoms),
  ];

  // authorizationList
  const userAuthSig = await sign7702Auth(cid, user.account);
  const userAuth = {
    chainId: userAuthSig.chainId,
    address: userAuthSig.address,
    nonce: userAuthSig.nonce,
    yParity: userAuthSig.yParity,
    r: userAuthSig.r,
    s: userAuthSig.s,
  };
  const agentAuthSig = await sign7702Auth(cid, agent.account);
  const agentAuth = {
    chainId: agentAuthSig.chainId,
    address: agentAuthSig.address,
    nonce: agentAuthSig.nonce,
    yParity: agentAuthSig.yParity,
    r: agentAuthSig.r,
    s: agentAuthSig.s,
  };

  let authorizationList: Array<Record<string, unknown>>;
  if (opts.doubleAuth) authorizationList = [userAuth, agentAuth];
  else if (opts.agentAuth) authorizationList = [agentAuth];
  else authorizationList = [userAuth];

  const pcLeafRoot = [wireDelegation(leafSigned), wireDelegation(rootSigned)];
  const pcRootLeaf = [wireDelegation(rootSigned), wireDelegation(leafSigned)];
  const permissionContext = ordering === "leaf,root" ? pcLeafRoot : pcRootLeaf;

  const r = await estimate(
    cid,
    [{ permissionContext, executions }],
    authorizationList,
  );
  console.log(`[p2] estimate http=${r.httpStatus}`);
  console.log("[p2] estimate raw:", r.raw);
  return r;
}

if (import.meta.main) {
  // Probe 2: Plan A, user auth, both orderings
  await runChain2(84532, "leaf,root");
  await runChain2(84532, "root,leaf");
  // Probe 3: agent auth instead of user; and double auth (expect 4210)
  await runChain2(84532, "leaf,root", { agentAuth: true });
  await runChain2(84532, "leaf,root", { doubleAuth: true });
}
