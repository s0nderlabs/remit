// INTEGRATION (network, estimate-only, FREE): engine code against the LIVE mainnet
// relayer with fresh UNFUNDED throwaway keys. Never calls send. The pass criterion
// for composed estimates is the probe-proven discrimination: a structurally-valid
// request reaches on-chain simulation and fails ONLY on the ERC20 balance check.
// Any enforcer/validation error = engine bug.
//
// Run: REMIT_IT=1 bun test relayer.itest.ts

import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Relayer } from "../src/relayer";
import {
  buildRootDelegation,
  carveLeafDelegation,
  signWithPrivateKey,
  signWithSmartAccount,
  userSmartAccount,
  sign7702Auth,
  erc20TransferExecution,
  feeExecution,
  erc20ApproveExecution,
} from "../src/delegations";
import { compileCard, applyOrArgs, payLeafScope, contractLeafScope } from "../src/compiler";
import { CHAINS, FEE_COLLECTOR, SWAP_ROUTER_02 } from "../src/chains";
import { usdcToAtoms } from "../src/money";

const RUN = !!process.env.REMIT_IT;
const CID = 8453 as const;
const C = CHAINS[CID];

const BALANCE_ERR = /transfer amount exceeds balance/i;

describe.skipIf(!RUN)("live relayer (mainnet, estimate-only)", () => {
  const relayer = new Relayer(CID);

  test("getCapabilities matches pinned constants", async () => {
    const caps = await relayer.getCapabilities();
    expect(caps.targetAddress.toLowerCase()).toBe(C.targetAddress.toLowerCase());
    expect(caps.feeCollector.toLowerCase()).toBe(FEE_COLLECTOR.toLowerCase());
  }, 20_000);

  test("getFeeData: minFee 0.01 USDC", async () => {
    const fee = await relayer.getFeeData(C.usdc);
    expect(fee.minFee).toBe("0.01");
    expect(fee.context.length).toBeGreaterThan(10);
  }, 20_000);

  test("chain-2 pay card: full engine path reaches balance check", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agentPk = generatePrivateKey();
    const agent = privateKeyToAccount(agentPk);
    const now = Math.floor(Date.now() / 1000);

    const compiled = compileCard(
      { pay: { period: { amount: "25", seconds: 604800 } }, expiry: now + 30 * 86400 },
      { revocationNonce: 0n, now },
    );
    const smart = await userSmartAccount(user, CID);
    const root = await signWithSmartAccount(
      smart,
      buildRootDelegation({ delegator: user.address, delegate: agent.address, caveats: compiled.rootCaveats }),
      CID,
    );
    const fee = usdcToAtoms("0.01");
    const amount = usdcToAtoms("0.01");
    const leaf = await signWithPrivateKey(
      agentPk,
      carveLeafDelegation({ parent: root, from: agent.address, scope: payLeafScope(fee + amount, CID) as never, chainId: CID }),
      CID,
    );
    const auth = await sign7702Auth(user, CID); // unfunded -> live nonce 0
    const est = await relayer.estimate(
      [{
        permissionContext: [leaf, root], // LEAF-FIRST
        executions: [
          erc20TransferExecution(C.usdc, agent.address, amount),
          feeExecution(FEE_COLLECTOR, fee, CID),
        ],
      }],
      [auth],
    );
    expect(est.success).toBe(false);
    expect(est.error ?? "").toMatch(BALANCE_ERR); // reached simulation; only money missing
  }, 30_000);

  test("composite card: BOTH modes reach balance check off ONE signed root", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agentPk = generatePrivateKey();
    const agent = privateKeyToAccount(agentPk);
    const now = Math.floor(Date.now() / 1000);

    const compiled = compileCard(
      {
        pay: { period: { amount: "50", seconds: 604800 } },
        contract: {
          targets: [SWAP_ROUTER_02],
          selectors: [
            "approve(address,uint256)",
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
          ],
        },
        expiry: now + 7 * 86400,
      },
      { revocationNonce: 0n, now },
    );
    const smart = await userSmartAccount(user, CID);
    // Sign ONCE with placeholder (pay) args.
    const rootSigned = await signWithSmartAccount(
      smart,
      buildRootDelegation({ delegator: user.address, delegate: agent.address, caveats: compiled.rootCaveats }),
      CID,
    );
    const fee = usdcToAtoms("0.01");
    const auth = await sign7702Auth(user, CID);

    // ---- pay mode: swap in pay-group args, transfer-shaped executions ----
    {
      const root = { ...rootSigned, caveats: applyOrArgs(compiled, "pay") };
      const leaf = await signWithPrivateKey(
        agentPk,
        carveLeafDelegation({ parent: root, from: agent.address, scope: payLeafScope(fee + 10_000n, CID) as never, chainId: CID }),
        CID,
      );
      const est = await relayer.estimate(
        [{
          permissionContext: [leaf, root],
          executions: [erc20TransferExecution(C.usdc, agent.address, 10_000n), feeExecution(FEE_COLLECTOR, fee, CID)],
        }],
        [auth],
      );
      expect(est.success).toBe(false);
      expect(est.error ?? "").toMatch(BALANCE_ERR);
    }

    // ---- contract mode: SAME signed root, contract-group args, 3-execution swap ----
    {
      const root = { ...rootSigned, caveats: applyOrArgs(compiled, "contract") };
      const leaf = await signWithPrivateKey(
        agentPk,
        carveLeafDelegation({
          parent: root,
          from: agent.address,
          scope: contractLeafScope(compiled.terms.contract!, CID) as never,
          chainId: CID,
        }),
        CID,
      );
      const swapData = {
        target: SWAP_ROUTER_02,
        value: "0",
        data: ("0x04e45aaf" + // exactInputSingle selector
          C.usdc.slice(2).padStart(64, "0") +
          "4200000000000000000000000000000000000006".padStart(64, "0") +
          (500).toString(16).padStart(64, "0") +
          user.address.slice(2).padStart(64, "0") +
          (50_000).toString(16).padStart(64, "0") +
          "0".padStart(64, "0") +
          "0".padStart(64, "0")) as `0x${string}`,
      };
      const est = await relayer.estimate(
        [{
          permissionContext: [leaf, root],
          executions: [
            erc20ApproveExecution(C.usdc, SWAP_ROUTER_02, 50_000n),
            swapData,
            feeExecution(FEE_COLLECTOR, fee, CID),
          ],
        }],
        [auth],
      );
      expect(est.success).toBe(false);
      // approve happens first on an unfunded account; the swap or fee transfer trips
      // the balance check (any ENFORCER error here = compiler bug)
      expect(est.error ?? "").not.toMatch(/Enforcer|invalid-method|not-allowed|invalid-group/i);
    }
  }, 60_000);
});
