// Offline admin-ops tests: the FakeRelayer drives revoke/nuke through BOTH signing
// lanes (server-signed adminSend; client-signed prepare/finalize) with zero network.
// The user is a real local key signing real delegations — only the relayer, code
// check and nonce read are faked. Locks the demo money-shot before any refactor.

import { beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { Store } from "../src/store";
import { issueRootCard, issueSubCard } from "../src/issuance";
import {
  finalizeAdminOp,
  nukeAll,
  prepareNuke,
  prepareRevoke,
  revokeCard,
  type OpsDeps,
  type PreparedAdminOp,
} from "../src/ops";
import { signWithSmartAccount, userSmartAccount } from "../src/delegations";
import { RefusalError } from "../src/errors";
import type { Relayer, RelayerTransaction, EstimateResult } from "../src/relayer";
import type { Wire7702Auth } from "../src/types";
import { CHAINS, DELEGATION_MANAGER } from "../src/chains";

const NOW = 1_780_000_000;

const userPk = generatePrivateKey();
const user = privateKeyToAccount(userPk);
const stranger = privateKeyToAccount(generatePrivateKey());

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "c".repeat(64);
});

class FakeRelayer {
  calls: { estimates: RelayerTransaction[][]; sends: RelayerTransaction[][]; auths: (Wire7702Auth[] | undefined)[] } = {
    estimates: [],
    sends: [],
    auths: [],
  };
  requiredFee = "10000";
  bumpFeeOnce: string | null = null;
  failEstimateWith: string | null = null;
  statusResult: { status: number; txHash: `0x${string}` | null } = { status: 200, txHash: "0xabc1" as never };

  async getFeeData() {
    return {
      minFee: "0.01",
      rate: 1598,
      gasPrice: "1",
      expiry: NOW + 600,
      feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address,
      targetAddress: CHAINS[8453].targetAddress,
      context: "ctx",
    };
  }
  async getCapabilities() {
    return {
      targetAddress: CHAINS[8453].targetAddress,
      feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address,
      tokens: [],
    };
  }
  async estimate(transactions: RelayerTransaction[], auth?: Wire7702Auth[]): Promise<EstimateResult> {
    this.calls.estimates.push(transactions);
    this.calls.auths.push(auth);
    if (this.failEstimateWith) {
      return { success: false, requiredPaymentAmount: null, context: null, error: this.failEstimateWith, raw: null };
    }
    if (this.bumpFeeOnce) {
      const fee = this.bumpFeeOnce;
      this.bumpFeeOnce = null;
      return { success: true, requiredPaymentAmount: fee, context: "ctx-bump", error: null, raw: null };
    }
    return { success: true, requiredPaymentAmount: this.requiredFee, context: "ctx-ok", error: null, raw: null };
  }
  async send(transactions: RelayerTransaction[], _context: string): Promise<string> {
    this.calls.sends.push(transactions);
    return "0xrequestid";
  }
  async getStatus() {
    return { ...this.statusResult, raw: null };
  }
  async waitForStatus() {
    return { ...this.statusResult, raw: null, timedOut: false };
  }
}

function mkWorld() {
  const store = new Store(":memory:");
  store.upsertUser({
    id: "u1",
    address: user.address,
    auth7702Json: JSON.stringify({ chainId: "0x2105", address: "0x0", nonce: "0x0", yParity: "0x0", r: "0x0", s: "0x0" }),
  });
  const relayer = new FakeRelayer();
  const opsDeps: OpsDeps = {
    store,
    relayer: relayer as unknown as Relayer,
    userSigner: user,
    codeCheck: async () => true,
    confirmViaChain: false,
    feeJitter: (base) => base,
    revocationNonceOverride: 1n,
  };
  return { store, relayer, opsDeps };
}

async function mkCard(store: Store) {
  return issueRootCard(
    { store, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
    { userId: "u1", name: "root", terms: { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 } },
  );
}

/** sign the prepared admin leaf the way the browser does (Stateless7702 EIP-712) */
async function clientSign(prepared: PreparedAdminOp, signer = user): Promise<Hex> {
  const smart = await userSmartAccount(signer, prepared.chainId);
  const signed = await signWithSmartAccount(smart, prepared.delegation, prepared.chainId);
  return signed.signature;
}

// ---------------------------------------------------------------------------
// Server-signed lane (locks pre-refactor behavior)
// ---------------------------------------------------------------------------

describe("server-signed revoke/nuke", () => {
  test("top-level revoke: disableDelegation to the DelegationManager, subtree dies", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const sub = await issueSubCard(
      { store, now: () => NOW + 10 },
      { parentCardId: root.cardId, name: "sub", terms: {} },
    );

    const result = await revokeCard(opsDeps, root.cardId);
    expect(result.txHash).toBe("0xabc1");
    expect(relayer.calls.sends.length).toBe(1);
    const [tx] = relayer.calls.sends[0]!;
    expect(tx!.executions[0]!.target.toLowerCase()).toBe(DELEGATION_MANAGER.toLowerCase());
    // permissionContext: ONE user-signed leaf, delegate = relayer target
    expect(tx!.permissionContext.length).toBe(1);
    expect(tx!.permissionContext[0]!.delegator).toBe(user.address);
    expect(tx!.permissionContext[0]!.delegate).toBe(CHAINS[8453].targetAddress);
    expect(store.getCard(root.cardId)!.status).toBe("revoked");
    expect(store.getCard(sub.cardId)!.status).toBe("revoked");
  });

  test("sub-card revoke: server-side kill + refusal explaining the layering, NO send", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const sub = await issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: root.cardId, name: "sub", terms: {} });

    await expect(revokeCard(opsDeps, sub.cardId)).rejects.toThrow(RefusalError);
    expect(store.getCard(sub.cardId)!.status).toBe("revoked");
    expect(store.getCard(root.cardId)!.status).toBe("active");
    expect(relayer.calls.sends.length).toBe(0);
  });

  test("nuke: incrementNonce to the NonceEnforcer, every card dies, nonce stored", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const a = await mkCard(store);
    const b = await mkCard(store);

    const result = await nukeAll(opsDeps, "u1");
    expect(result.newNonce).toBe(1n);
    expect(relayer.calls.sends.length).toBe(1);
    const [tx] = relayer.calls.sends[0]!;
    expect(tx!.executions[0]!.target.toLowerCase()).not.toBe(DELEGATION_MANAGER.toLowerCase()); // NonceEnforcer
    expect(store.getCard(a.cardId)!.status).toBe("nuked");
    expect(store.getCard(b.cardId)!.status).toBe("nuked");
    expect(store.getUser("u1")!.revocation_nonce).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Client-signed lane (the Privy path)
// ---------------------------------------------------------------------------

describe("client-signed prepare/finalize", () => {
  test("prepareRevoke top-level: unsigned admin leaf, delegator = A_user, delegate = relayer target", async () => {
    const { store } = mkWorld();
    const root = await mkCard(store);

    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;
    expect(prepared.kind).toBe("revoke");
    expect(prepared.cardId).toBe(root.cardId);
    expect(prepared.userAddress).toBe(user.address);
    expect(prepared.delegation.signature).toBe("0x");
    expect(prepared.delegation.delegator).toBe(user.address);
    expect(prepared.delegation.delegate).toBe(CHAINS[8453].targetAddress);
    expect(prepared.adminTarget.toLowerCase()).toBe(DELEGATION_MANAGER.toLowerCase());
    // calldata disables THIS card's delegation
    expect(prepared.adminCalldata.length).toBeGreaterThan(10);
  });

  test("prepareRevoke sub-card: immediate server-side kill, nothing to sign", async () => {
    const { store } = mkWorld();
    const root = await mkCard(store);
    const sub = await issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: root.cardId, name: "sub", terms: {} });

    const result = prepareRevoke({ store, now: () => NOW }, sub.cardId);
    expect(result).toEqual({ done: true, cardId: sub.cardId });
    expect(store.getCard(sub.cardId)!.status).toBe("revoked");
    expect(store.getCard(root.cardId)!.status).toBe("active");
  });

  test("prepareRevoke on an already-revoked card refuses", async () => {
    const { store } = mkWorld();
    const root = await mkCard(store);
    store.setSubtreeStatus(root.cardId, "revoked");
    expect(() => prepareRevoke({ store, now: () => NOW }, root.cardId)).toThrow(RefusalError);
  });

  test("finalize with the WRONG signer is refused before any relayer call", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;

    const badSig = await clientSign(prepared, stranger);
    await expect(finalizeAdminOp(opsDeps, prepared, badSig)).rejects.toThrow(/does not recover/);
    expect(relayer.calls.estimates.length).toBe(0);
    expect(relayer.calls.sends.length).toBe(0);
    expect(store.getCard(root.cardId)!.status).toBe("active");
  });

  test("finalize revoke happy path: onValidated fires once, subtree dies, tx returned", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const sub = await issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: root.cardId, name: "sub", terms: {} });
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;

    let validated = 0;
    const sig = await clientSign(prepared);
    const result = await finalizeAdminOp(opsDeps, prepared, sig, { onValidated: () => validated++ });
    expect(validated).toBe(1);
    expect(result.txHash).toBe("0xabc1");
    expect(store.getCard(root.cardId)!.status).toBe("revoked");
    expect(store.getCard(sub.cardId)!.status).toBe("revoked");
    const [tx] = relayer.calls.sends[0]!;
    expect(tx!.executions[0]!.data).toBe(prepared.adminCalldata);
  });

  test("fee rebuild keeps the ONE client signature valid across attempts", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;
    const sig = await clientSign(prepared);

    relayer.bumpFeeOnce = "20000"; // first estimate demands more fee
    const result = await finalizeAdminOp(opsDeps, prepared, sig);
    expect(result.txHash).toBe("0xabc1");
    expect(relayer.calls.estimates.length).toBe(2);
    expect(relayer.calls.sends.length).toBe(1);
    // the leaf (and its signature) is byte-identical in both attempts
    const leaf1 = relayer.calls.estimates[0]![0]!.permissionContext[0]!;
    const leaf2 = relayer.calls.estimates[1]![0]!.permissionContext[0]!;
    expect(leaf2.signature).toBe(leaf1.signature);
    expect(leaf2.salt).toBe(leaf1.salt);
    // only the fee execution changed
    expect(relayer.calls.estimates[1]![0]!.executions[1]!.data).not.toBe(
      relayer.calls.estimates[0]![0]!.executions[1]!.data,
    );
  });

  test("prepareNuke + finalize: whole tree dies, nonce bumped, calldata targets NonceEnforcer", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const a = await mkCard(store);
    const sub = await issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: a.cardId, name: "sub", terms: {} });
    const b = await mkCard(store);

    const prepared = prepareNuke({ store, now: () => NOW }, "u1");
    expect(prepared.kind).toBe("nuke");
    expect(prepared.cardId).toBeNull();
    expect(prepared.adminTarget.toLowerCase()).not.toBe(DELEGATION_MANAGER.toLowerCase());

    const sig = await clientSign(prepared);
    const result = await finalizeAdminOp(opsDeps, prepared, sig);
    expect(result.newNonce).toBe(1n);
    expect(store.getCard(a.cardId)!.status).toBe("nuked");
    expect(store.getCard(sub.cardId)!.status).toBe("nuked");
    expect(store.getCard(b.cardId)!.status).toBe("nuked");
    expect(store.getUser("u1")!.revocation_nonce).toBe("1");
    expect(relayer.calls.sends.length).toBe(1);
  });

  test("missing signature refused; not-7702-coded user without stored auth fails closed", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;

    await expect(finalizeAdminOp(opsDeps, prepared, "0x" as Hex)).rejects.toThrow(/missing admin leaf signature/);

    // user not coded + no stored auth -> EngineError before send
    store.upsertUser({ id: "u1", address: user.address, auth7702Json: null });
    // upsert COALESCEs, so wipe via a fresh user instead
    const store2 = new Store(":memory:");
    store2.upsertUser({ id: "u1", address: user.address });
    const root2 = await issueRootCard(
      { store: store2, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
      { userId: "u1", name: "root", terms: { pay: { period: { amount: "25", seconds: 604800 } } } },
    );
    const prepared2 = prepareRevoke({ store: store2, now: () => NOW }, root2.cardId) as PreparedAdminOp;
    const sig2 = await clientSign(prepared2);
    await expect(
      finalizeAdminOp({ ...opsDeps, store: store2, codeCheck: async () => false }, prepared2, sig2),
    ).rejects.toThrow(/not 7702-coded/);
    expect(relayer.calls.sends.length).toBe(0);
  });

  test("authorizationList is forwarded when the user has no 7702 code yet", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;
    const sig = await clientSign(prepared);

    await finalizeAdminOp(
      { ...opsDeps, codeCheck: async () => false, accountNonce: async () => 0 },
      prepared,
      sig,
    );
    expect(relayer.calls.auths[0]).toBeDefined();
    expect(relayer.calls.auths[0]!.length).toBe(1);
  });

  test("a STALE stored 7702 auth (account nonce advanced) is refused before send", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;
    const sig = await clientSign(prepared);

    // stored auth was signed at nonce 0; the account has since transacted (nonce 3)
    await expect(
      finalizeAdminOp({ ...opsDeps, codeCheck: async () => false, accountNonce: async () => 3 }, prepared, sig),
    ).rejects.toThrow(/stale/);
    expect(relayer.calls.sends.length).toBe(0);
  });

  test("a TIMED-OUT confirmation throws and does NOT mark the tree dead (DB/chain divergence guard)", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;
    const sig = await clientSign(prepared);

    relayer.statusResult = { status: 102, txHash: null }; // still pending at timeout
    await expect(finalizeAdminOp(opsDeps, prepared, sig)).rejects.toThrow(/not confirmed in time/);
    // the delegation may still be LIVE on-chain: the store must not claim it's revoked
    expect(store.getCard(root.cardId)!.status).toBe("active");
  });

  test("finalize against an already-dead card short-circuits: no relayer send, no fee burned", async () => {
    const { store, relayer, opsDeps } = mkWorld();
    const root = await mkCard(store);
    const prepared = prepareRevoke({ store, now: () => NOW }, root.cardId) as PreparedAdminOp;
    const sig = await clientSign(prepared);

    store.setAllUserCardsStatus("u1", "nuked"); // a concurrent tab nuked first
    const result = await finalizeAdminOp(opsDeps, prepared, sig);
    expect(result.txHash).toBeNull();
    expect(relayer.calls.sends.length).toBe(0); // no duplicate admin tx, no fee
    expect(store.getCard(root.cardId)!.status).toBe("nuked"); // terminal status preserved

    // same for a stale nuke against an all-dead tree
    const preparedNuke = prepareNuke({ store, now: () => NOW }, "u1");
    const sigNuke = await clientSign(preparedNuke);
    const nukeResult = await finalizeAdminOp(opsDeps, preparedNuke, sigNuke);
    expect(nukeResult.txHash).toBeNull();
    expect(relayer.calls.sends.length).toBe(0);
  });
});
