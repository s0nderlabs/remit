// Offline pipeline tests: a FakeRelayer drives the full spend() loop (carve, estimate,
// fee rebuild, send, status, charge rows, receipts) with zero network. The user is a
// real local key signing real delegations; only the relayer + code-check are faked.

import { beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { Store } from "../src/store";
import { issueRootCard, issueSubCard, rotateCardSecret } from "../src/issuance";
import { spend, cardState, type SpendDeps } from "../src/spend";
import { freezeCard, unfreezeCard, agentRevokeSubcard } from "../src/ops";
import { RefusalError } from "../src/errors";
import { hashCardSecret } from "../src/custody";
import type { Relayer, RelayerTransaction, EstimateResult } from "../src/relayer";
import type { Wire7702Auth } from "../src/types";
import { CHAINS } from "../src/chains";

const NOW = 1_780_000_000;
const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

const userPk = generatePrivateKey();
const user = privateKeyToAccount(userPk);

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "c".repeat(64);
});

// ---------------------------------------------------------------------------
// FakeRelayer: probe-faithful behavior, scriptable per test
// ---------------------------------------------------------------------------

class FakeRelayer {
  calls: { estimates: RelayerTransaction[][]; sends: RelayerTransaction[][] } = { estimates: [], sends: [] };
  requiredFee = "10000";
  /** if set, first estimate demands this then accepts */
  bumpFeeOnce: string | null = null;
  failEstimateWith: string | null = null;
  statusResult: { status: number; txHash: `0x${string}` | null } = { status: 200, txHash: "0xabc1" as never };

  async getFeeData() {
    return { minFee: "0.01", rate: 1598, gasPrice: "1", expiry: NOW + 600, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address, targetAddress: CHAINS[8453].targetAddress, context: "ctx" };
  }
  async getCapabilities() {
    return { targetAddress: CHAINS[8453].targetAddress, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address, tokens: [] };
  }
  async estimate(transactions: RelayerTransaction[], _auth?: Wire7702Auth[]): Promise<EstimateResult> {
    this.calls.estimates.push(transactions);
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

function mkWorld(terms = { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 } as Parameters<typeof issueRootCard>[1]["terms"]) {
  const store = new Store(":memory:");
  store.upsertUser({ id: "u1", address: user.address, auth7702Json: JSON.stringify({ chainId: "0x2105", address: "0x0", nonce: "0x0", yParity: "0x0", r: "0x0", s: "0x0" }) });
  const relayer = new FakeRelayer();
  const deps: SpendDeps = {
    store,
    relayer: relayer as unknown as Relayer,
    now: () => NOW + 60,
    codeCheck: async () => true, // pretend A_user is already 7702-coded
    confirmViaChain: false, // FakeRelayer confirms via getStatus
    feeJitter: (base) => base, // deterministic fees in tests
  };
  return { store, relayer, deps };
}

async function mkCard(store: Store, terms?: Parameters<typeof issueRootCard>[1]["terms"]) {
  return issueRootCard(
    { store, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
    { userId: "u1", name: "test card", terms: terms ?? { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 } },
  );
}

describe("issuance", () => {
  test("root card: stored, secret hashed, K_agent delegate, signed delegation", async () => {
    const { store } = mkWorld();
    const issued = await mkCard(store);
    const card = store.getCardBySecretHash(hashCardSecret(issued.secret))!;
    expect(card.id).toBe(issued.cardId);
    expect(card.delegation.delegate).toBe(issued.kAgentAddress);
    expect(card.delegation.delegator).toBe(user.address);
    expect(card.delegation.signature.length).toBeGreaterThan(4);
    expect(card.status).toBe("active");
  });

  test("sub-card: parent K_agent signs, authority chains, terms attenuate", async () => {
    const { store } = mkWorld();
    const parent = await mkCard(store);
    const sub = await issueSubCard(
      { store, now: () => NOW + 10 },
      { parentCardId: parent.cardId, name: "sub", terms: { pay: { period: { amount: "5", seconds: 86400 } } } },
    );
    const subRow = store.getCard(sub.cardId)!;
    const parentRow = store.getCard(parent.cardId)!;
    expect(subRow.parent_card_id).toBe(parent.cardId);
    expect(subRow.delegation.delegator).toBe(parentRow.k_agent_address);
    expect(subRow.terms.expiry).toBe(parentRow.terms.expiry); // inherited
    expect(store.ancestorChain(sub.cardId).map((c) => c.id)).toEqual([sub.cardId, parent.cardId]);
  });

  test("sub-card over parent -> exceeds_parent_terms; subcards off -> subcards_disabled", async () => {
    const { store } = mkWorld();
    const parent = await mkCard(store);
    await expect(
      issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: parent.cardId, name: "fat", terms: { pay: { period: { amount: "100", seconds: 604800 } } } }),
    ).rejects.toMatchObject({ code: "exceeds_parent_terms" });

    const locked = await mkCard(store, { pay: { lifetime: { amount: "10" } }, subcards: false });
    await expect(
      issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: locked.cardId, name: "x", terms: {} }),
    ).rejects.toMatchObject({ code: "subcards_disabled" });
  });
});

describe("spend pipeline (fake relayer)", () => {
  test("happy path: receipt + confirmed charge + counters", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    const receipt = await spend(deps, issued.cardId, {
      kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000_000n, memo: "coffee data",
    });
    expect(receipt.status).toBe("confirmed");
    expect(receipt.tx).toBe("0xabc1");
    expect(receipt.amount).toBe("1");
    expect(receipt.fee).toBe("0.01");
    expect(receipt.remaining_this_period).toBe("23.99"); // 25 - 1 - 0.01
    // wire shape: leaf first, then root; work exec then fee exec
    const sent = relayer.calls.sends[0]![0]!;
    expect(sent.permissionContext.length).toBe(2);
    expect(sent.permissionContext[0]!.delegate.toLowerCase()).toBe(CHAINS[8453].targetAddress.toLowerCase());
    expect(sent.executions.length).toBe(2);
    const charges = store.listCharges(issued.cardId);
    expect(charges.length).toBe(1);
    expect(charges[0]!.status).toBe("confirmed");
  });

  test("fee rebuild: relayer demands more, leaf re-carved, single send", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    relayer.bumpFeeOnce = "12821";
    relayer.requiredFee = "12821";
    const receipt = await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n });
    expect(receipt.fee).toBe("0.012821");
    expect(relayer.calls.estimates.length).toBe(2);
    expect(relayer.calls.sends.length).toBe(1);
  });

  test("idempotency: same key returns original receipt, no second send", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    const r1 = await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n, idempotencyKey: "k1" });
    const r2 = await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n, idempotencyKey: "k1" });
    expect(r1.tx).toBe(r2.tx);
    expect(relayer.calls.sends.length).toBe(1);
  });

  test("refusals: over_period_limit (fee-inclusive), merchant, per-tx, frozen, expired", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store, {
      pay: { period: { amount: "1", seconds: 604800 } },
      merchants: [MERCHANT],
      perTxMax: "0.5",
      expiry: NOW + 3600,
    });
    // over period (1.00 cap, 0.999 + 0.01 fee > 1)
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 999_000n }),
    ).rejects.toMatchObject({ code: "per_tx_exceeded" }); // perTxMax 0.5 trips first
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 495_000n }),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 495_000n }),
    ).rejects.toMatchObject({ code: "over_period_limit" }); // 0.505 spent, +0.495+0.01 > 1
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: OTHER, amountAtoms: 1_000n }),
    ).rejects.toMatchObject({ code: "merchant_not_allowed" });

    freezeCard(store, issued.cardId);
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000n }),
    ).rejects.toMatchObject({ code: "card_frozen" });
    unfreezeCard(store, issued.cardId);

    const expiredDeps = { ...deps, now: () => NOW + 7200 };
    await expect(
      spend(expiredDeps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000n }),
    ).rejects.toMatchObject({ code: "card_expired" });
  });

  test("sub-card spend chains [leaf, child, root]; parent freeze blocks child", async () => {
    const { store, relayer, deps } = mkWorld();
    const parent = await mkCard(store);
    const sub = await issueSubCard(
      { store, now: () => NOW + 10 },
      { parentCardId: parent.cardId, name: "sub", terms: { pay: { period: { amount: "5", seconds: 86400 } } } },
    );
    const receipt = await spend(deps, sub.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n });
    expect(receipt.status).toBe("confirmed");
    const sent = relayer.calls.sends[0]![0]!;
    expect(sent.permissionContext.length).toBe(3); // leaf, child, root
    // parent budget sees the child's spend (subtree accounting)
    expect(cardState(store, parent.cardId, NOW + 70)!.remaining_this_period).toBe("24.98");

    freezeCard(store, parent.cardId);
    await expect(
      spend(deps, sub.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000n }),
    ).rejects.toMatchObject({ code: "card_frozen" });
  });

  test("parent budget refuses child overdraft BEFORE chain (typed, not revert)", async () => {
    const { store, deps } = mkWorld();
    const parent = await mkCard(store, { pay: { period: { amount: "1", seconds: 604800 } } });
    const sub = await issueSubCard(
      { store, now: () => NOW + 10 },
      // child window smaller but cap inherits parent remaining (1.00)
      { parentCardId: parent.cardId, name: "sub", terms: {} },
    );
    await expect(
      spend(deps, sub.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 995_000n }),
    ).rejects.toMatchObject({ code: "over_period_limit" });
  });

  test("estimate enforcer error maps to typed refusal", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    relayer.failEstimateWith = "Gas estimation failed: Error(ERC20PeriodTransferEnforcer:transfer-amount-exceeded)";
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n }),
    ).rejects.toMatchObject({ code: "over_period_limit" });
    // no charge row left behind on refusal
    expect(store.listCharges(issued.cardId).length).toBe(0);
  });

  test("reverted send -> failed charge, EngineError", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    relayer.statusResult = { status: 500, txHash: "0xdead" as never };
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n }),
    ).rejects.toThrow("reverted");
    expect(store.listCharges(issued.cardId)[0]!.status).toBe("failed");
    // failed charges do NOT count against the budget
    expect(cardState(store, issued.cardId, NOW + 70)!.remaining_this_period).toBe("25");
  });

  test("maxUses exhausts subtree-wide", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store, { pay: { period: { amount: "25", seconds: 604800 } }, maxUses: 1 });
    await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000n });
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000n }),
    ).rejects.toMatchObject({ code: "uses_exhausted" });
  });
});

describe("ops (server-side)", () => {
  test("agentRevokeSubcard: descendants only", async () => {
    const { store } = mkWorld();
    const a = await mkCard(store);
    const b = await mkCard(store);
    const subA = await issueSubCard({ store, now: () => NOW + 10 }, { parentCardId: a.cardId, name: "s", terms: {} });
    expect(() => agentRevokeSubcard(store, a.cardId, subA.cardId)).not.toThrow();
    expect(store.getCard(subA.cardId)!.status).toBe("revoked");
    expect(() => agentRevokeSubcard(store, a.cardId, b.cardId)).toThrow(RefusalError);
    expect(() => agentRevokeSubcard(store, a.cardId, a.cardId)).toThrow(RefusalError);
  });

  test("rotate: old secret dies, new resolves, same card; re-view works", async () => {
    const { store } = mkWorld();
    const issued = await mkCard(store);
    const newSecret = await rotateCardSecret(store, issued.cardId);
    expect(store.getCardBySecretHash(hashCardSecret(issued.secret))).toBeNull();
    expect(store.getCardBySecretHash(hashCardSecret(newSecret))!.id).toBe(issued.cardId);
    const { viewCardSecret } = await import("../src/issuance");
    expect(await viewCardSecret(store, issued.cardId)).toBe(newSecret);
  });
});
