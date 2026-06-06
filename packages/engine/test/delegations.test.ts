// Offline delegation tests. The args-invariance test is LOAD-BEARING: the whole
// composite-card design (sign root once, mutate OR args per redemption) rests on it.

import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type Hex } from "viem";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import {
  buildRootDelegation,
  buildChildDelegation,
  carveLeafDelegation,
  signWithPrivateKey,
  wireDelegation,
  freshSalt,
  erc20TransferExecution,
  sign7702Auth,
} from "../src/delegations";
import { compileCard, applyOrArgs, payLeafScope } from "../src/compiler";
import { CHAINS, DELEGATION_MANAGER, LOGICAL_OR_WRAPPER, SWAP_ROUTER_02 } from "../src/chains";

const NOW = 1_780_000_000;
const ROOT_AUTHORITY = ("0x" + "ff".repeat(32)) as Hex;
const USER = "0x5117715db9A94F66E56Cb564728615842DC07bba" as Address;
const TARGET = CHAINS[8453].targetAddress;

const agentPk = generatePrivateKey();
const agent = privateKeyToAccount(agentPk);

function compiledPay() {
  return compileCard(
    { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 },
    { revocationNonce: 0n, now: NOW },
  );
}

describe("root delegation", () => {
  test("ROOT_AUTHORITY + caveats + fresh salt", () => {
    const c = compiledPay();
    const root = buildRootDelegation({ delegator: USER, delegate: agent.address, caveats: c.rootCaveats });
    expect(root.authority).toBe(ROOT_AUTHORITY);
    expect(root.delegator).toBe(USER);
    expect(root.delegate).toBe(agent.address);
    expect(root.caveats.length).toBe(3);
    expect(root.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(root.signature).toBe("0x");
  });
});

describe("ARGS-INVARIANCE (the composite-card load-bearing fact)", () => {
  test("delegation hash ignores caveat args; sensitive to terms/salt/delegate", () => {
    const c = compileCard(
      {
        pay: { period: { amount: "25", seconds: 604800 } },
        contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"] },
      },
      { revocationNonce: 0n, now: NOW },
    );
    const salt = freshSalt();
    const root = buildRootDelegation({ delegator: USER, delegate: agent.address, caveats: c.rootCaveats, salt });

    const payMode = { ...root, caveats: applyOrArgs(c, "pay") };
    const contractMode = { ...root, caveats: applyOrArgs(c, "contract") };
    expect(payMode.caveats[0]!.args).not.toBe(contractMode.caveats[0]!.args);

    const h = (d: typeof root) => hashDelegation(d as never);
    expect(h(payMode)).toBe(h(contractMode)); // args excluded -> one signature serves both modes
    expect(h({ ...root, salt: freshSalt() })).not.toBe(h(root));
    expect(h({ ...root, delegate: USER })).not.toBe(h(root));
  });
});

describe("child + leaf", () => {
  test("child authority = hashDelegation(signed parent)", async () => {
    const c = compiledPay();
    const root = buildRootDelegation({ delegator: USER, delegate: agent.address, caveats: c.rootCaveats });
    const signedRoot = await signWithPrivateKey(agentPk, root); // signer identity irrelevant for hashing
    const child = buildChildDelegation({
      parent: signedRoot,
      delegator: agent.address,
      delegate: USER,
      caveats: c.rootCaveats,
    });
    expect(child.authority).toBe(hashDelegation(signedRoot as never));
    expect(child.authority).not.toBe(ROOT_AUTHORITY);
  });

  test("leaf carve: delegate == relayer targetAddress, authority == hash(parent)", async () => {
    const c = compiledPay();
    const root = buildRootDelegation({ delegator: USER, delegate: agent.address, caveats: c.rootCaveats });
    const signedRoot = await signWithPrivateKey(agentPk, root);
    const leaf = carveLeafDelegation({
      parent: signedRoot,
      from: agent.address,
      scope: payLeafScope(1_020_000n) as never,
    });
    expect(leaf.delegate.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(leaf.delegator).toBe(agent.address);
    expect(leaf.authority).toBe(hashDelegation(signedRoot as never));
  });
});

describe("signing", () => {
  test("signWithPrivateKey produces a signature that recovers to the signer (EIP-712)", async () => {
    const c = compiledPay();
    const root = buildRootDelegation({ delegator: agent.address, delegate: USER, caveats: c.rootCaveats });
    const signed = await signWithPrivateKey(agentPk, root);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const valid = await verifyTypedData({
      address: agent.address,
      domain: { name: "DelegationManager", version: "1", chainId: 8453, verifyingContract: DELEGATION_MANAGER },
      types: {
        Caveat: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
        ],
        Delegation: [
          { name: "delegate", type: "address" },
          { name: "delegator", type: "address" },
          { name: "authority", type: "bytes32" },
          { name: "caveats", type: "Caveat[]" },
          { name: "salt", type: "uint256" },
        ],
      },
      primaryType: "Delegation",
      message: {
        delegate: signed.delegate,
        delegator: signed.delegator,
        authority: signed.authority,
        caveats: signed.caveats.map((cv) => ({ enforcer: cv.enforcer, terms: cv.terms })),
        salt: BigInt(signed.salt),
      },
      signature: signed.signature,
    });
    expect(valid).toBe(true);
  });

  test("7702 auth wire shape (offline via nonce override)", async () => {
    const auth = await sign7702Auth(agent, 8453, 0);
    expect(auth.chainId).toBe("0x2105");
    expect(auth.nonce).toBe("0x0");
    expect(auth.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(auth.r).toMatch(/^0x/);
    expect(["0x0", "0x1"]).toContain(auth.yParity);
  });
});

describe("wire formatting", () => {
  test("bigint salt normalized to hex", () => {
    const d = wireDelegation({
      delegate: USER,
      delegator: USER,
      authority: ROOT_AUTHORITY,
      caveats: [{ enforcer: LOGICAL_OR_WRAPPER, terms: "0x12", args: "0x00" }],
      salt: 255n,
      signature: "0x",
    } as never);
    expect(d.salt).toBe("0xff");
  });

  test("transfer execution encodes correctly", () => {
    const e = erc20TransferExecution(CHAINS[8453].usdc, USER, 10_000n);
    expect(e.target).toBe(CHAINS[8453].usdc);
    expect(e.value).toBe("0");
    expect(e.data.startsWith("0xa9059cbb")).toBe(true); // transfer selector
  });
});
