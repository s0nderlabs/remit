// Offline pipeline tests: a FakeRelayer drives the full spend() loop (carve, estimate,
// fee rebuild, send, status, charge rows, receipts) with zero network. The user is a
// real local key signing real delegations; only the relayer + code-check are faked.

import { beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { Store } from "../src/store";
import { issueRootCard, issueSubCard, rotateCardSecret } from "../src/issuance";
import { spend, cardState, reconcilePending, type SpendDeps } from "../src/spend";
import { KeyedMutex } from "../src/mutex";
import { freezeCard, unfreezeCard, agentRevokeSubcard } from "../src/ops";
import { RefusalError } from "../src/errors";
import { hashCardSecret } from "../src/custody";
import type { Relayer, RelayerTransaction, EstimateResult } from "../src/relayer";
import type { CardTerms, Wire7702Auth, WireExecution } from "../src/types";
import { CHAINS } from "../src/chains";
import { erc20ApproveExecution } from "../src/delegations";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";

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
  /** if set, the next send throws (pre-broadcast failure: RPC blip / relayer 5xx) */
  sendThrowsOnce: string | null = null;
  /** hook fired during estimate — lets tests mutate state mid-pipeline (TOCTOU) */
  onEstimate: (() => void) | null = null;

  async getFeeData() {
    return { minFee: "0.01", rate: 1598, gasPrice: "1", expiry: NOW + 600, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address, targetAddress: CHAINS[8453].targetAddress, context: "ctx" };
  }
  async getCapabilities() {
    return { targetAddress: CHAINS[8453].targetAddress, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address, tokens: [] };
  }
  async estimate(transactions: RelayerTransaction[], _auth?: Wire7702Auth[]): Promise<EstimateResult> {
    this.calls.estimates.push(transactions);
    this.onEstimate?.();
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
    if (this.sendThrowsOnce) {
      const msg = this.sendThrowsOnce;
      this.sendThrowsOnce = null;
      throw new Error(msg);
    }
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

  test("sub-card nonce caveat binds to K_agent (0), NOT A_user's revocation nonce", async () => {
    // The on-chain NonceEnforcer checks the delegation's own delegator. A sub-card's
    // delegator is the parent's bare-EOA K_agent (nonce always 0), so the sub MUST
    // compile its nonce caveat to 0 even when A_user's revocation nonce is advanced.
    // Regression for the live-surfaced NonceEnforcer:invalid-nonce on nuked-then-reissued
    // trees. (Root binds to A_user's nonce; sub binds to 0.)
    const { store } = mkWorld();
    store.setRevocationNonce("u1", 3n);
    const parent = await issueRootCard(
      { store, userSigner: user, now: () => NOW, revocationNonceOverride: 3n },
      { userId: "u1", name: "root@3", terms: { pay: { period: { amount: "25", seconds: 604800 } } } },
    );
    const sub = await issueSubCard(
      { store, now: () => NOW + 10 },
      { parentCardId: parent.cardId, name: "sub", terms: { pay: { period: { amount: "5", seconds: 86400 } } } },
    );
    const ZERO32 = "0x" + "00".repeat(32);
    const nonceTerm = (cardId: string) => {
      const cs = store.getCard(cardId)!.compiled.rootCaveats;
      return cs[cs.length - 1]!.terms; // nonce caveat is always last (compiler invariant)
    };
    expect(BigInt(nonceTerm(parent.cardId))).toBe(3n); // root tracks A_user's nonce
    expect(nonceTerm(sub.cardId)).toBe(ZERO32); // sub tracks K_agent's nonce (0)
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

// ---------------------------------------------------------------------------
// Hardening: TOCTOU, idempotency retry, stale auth, reconcile, mutex
// ---------------------------------------------------------------------------

describe("hardening", () => {
  test("pre-broadcast send failure is RETRYABLE under the same idempotency key", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);

    relayer.sendThrowsOnce = "relayer 502";
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n, idempotencyKey: "kr" }),
    ).rejects.toThrow("relayer 502");
    const failed = store.chargeByIdempotency(issued.cardId, "kr")!;
    expect(failed.status).toBe("failed");
    expect(failed.request_id).toBeNull(); // never broadcast

    // same key retries fresh instead of sealing the failure
    const r2 = await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n, idempotencyKey: "kr" });
    expect(r2.status).toBe("confirmed");
    expect(relayer.calls.sends.length).toBe(1);
    // exactly one live row under the key; the dead one was cleared
    expect(store.chargeByIdempotency(issued.cardId, "kr")!.status).toBe("confirmed");
  });

  test("a failure WITH a request_id stays terminal under the same key (might be on-chain)", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    relayer.statusResult = { status: 500, txHash: "0xdead" as never };
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n, idempotencyKey: "kt" }),
    ).rejects.toThrow("reverted");
    relayer.statusResult = { status: 200, txHash: "0xabc1" as never };
    const replay = await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n, idempotencyKey: "kt" });
    expect(replay.status).toBe("failed"); // replayed receipt, no new attempt
    expect(relayer.calls.sends.length).toBe(1);
  });

  test("TOCTOU: a freeze landing during estimate blocks the send", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store);
    relayer.onEstimate = () => freezeCard(store, issued.cardId); // freeze lands mid-pipeline
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n }),
    ).rejects.toMatchObject({ code: "card_frozen" });
    expect(relayer.calls.sends.length).toBe(0);
    // the reserved charge row is released (failed), not stuck pending
    expect(store.listCharges(issued.cardId)[0]!.status).toBe("failed");
  });

  test("stale stored 7702 auth (nonce advanced) refuses; matching nonce proceeds", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store);
    await expect(
      spend(
        { ...deps, codeCheck: async () => false, accountNonce: async () => 5 },
        issued.cardId,
        { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n },
      ),
    ).rejects.toMatchObject({ code: "invalid_terms" });

    const ok = await spend(
      { ...deps, codeCheck: async () => false, accountNonce: async () => 0 },
      issued.cardId,
      { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000n },
    );
    expect(ok.status).toBe("confirmed");
  });

  test("reconcilePending settles stuck charges from fee-leg logs (confirm + fail)", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store);
    // two broadcast-but-unconfirmed charges, distinct fee fingerprints
    for (const [id, fee] of [["c1", 12_345n], ["c2", 999n]] as const) {
      store.insertCharge({
        id, card_id: issued.cardId, idempotency_key: null, kind: "pay", to_addr: MERCHANT,
        amount_atoms: 10_000n, fee_atoms: fee, request_id: `req-${id}`, tx_hash: null,
        status: "pending", memo: null, created_at: NOW - 600,
      });
    }
    const result = await reconcilePending(deps, {
      olderThanSeconds: 120,
      blockNumber: async () => 10_000n,
      scanFeeLogs: async () => [{ value: 12_345n, txHash: "0xfee1" as never }],
    });
    expect(result.reconciled).toBe(2);
    expect(store.getCharge("c1")!.status).toBe("confirmed");
    expect(store.getCharge("c1")!.tx_hash).toBe("0xfee1");
    expect(store.getCharge("c2")!.status).toBe("failed"); // budget freed
  });

  test("reconcilePending: two same-fee charges can't both claim ONE log (consumed set)", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store);
    // colliding jittered fees (the 0..999 jitter is only probabilistically unique)
    for (const id of ["d1", "d2"] as const) {
      store.insertCharge({
        id, card_id: issued.cardId, idempotency_key: null, kind: "pay", to_addr: MERCHANT,
        amount_atoms: 10_000n, fee_atoms: 777n, request_id: `req-${id}`, tx_hash: null,
        status: "pending", memo: null, created_at: NOW - 700,
      });
    }
    const result = await reconcilePending(deps, {
      olderThanSeconds: 120,
      blockNumber: async () => 10_000n,
      scanFeeLogs: async () => [{ value: 777n, txHash: "0xonlyone" as never }], // ONE real settlement
    });
    expect(result.reconciled).toBe(2);
    // exactly one charge claims the log; the phantom is failed (budget freed), never
    // double-confirmed against the same tx
    const statuses = [store.getCharge("d1")!.status, store.getCharge("d2")!.status].sort();
    expect(statuses).toEqual(["confirmed", "failed"]);
  });

  test("reconcilePending scans from each charge's broadcast block (since_block), not head-lookback", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store);
    store.insertCharge({
      id: "old1", card_id: issued.cardId, idempotency_key: null, kind: "pay", to_addr: MERCHANT,
      amount_atoms: 10_000n, fee_atoms: 555n, request_id: "req-old1", tx_hash: null,
      status: "pending", memo: null, created_at: NOW - 50_000, since_block: "100",
    });
    let scannedFrom: bigint | null = null;
    await reconcilePending(deps, {
      olderThanSeconds: 120,
      blockNumber: async () => 1_000_000n, // head far past any lookback window
      scanFeeLogs: async (_d, fromBlock) => {
        scannedFrom = fromBlock;
        return [{ value: 555n, txHash: "0xlanded" as never }];
      },
    });
    expect(scannedFrom).toBe(100n); // anchored at broadcast, immune to sweep downtime
    expect(store.getCharge("old1")!.status).toBe("confirmed"); // NOT wrongly failed
  });

  test("reconcilePending frees orphaned x402 reservations after the TTL", async () => {
    const { store, deps } = mkWorld();
    const issued = await mkCard(store);
    store.insertCharge({
      id: "x1", card_id: issued.cardId, idempotency_key: null, kind: "x402", to_addr: MERCHANT,
      amount_atoms: 5_000n, fee_atoms: 30_000n, request_id: null, tx_hash: null,
      status: "pending", memo: "x402 orphan", created_at: NOW - 4_000,
    });
    const result = await reconcilePending(deps, {
      olderThanSeconds: 600, // x402 orphan TTL = 6x this
      blockNumber: async () => 10_000n,
      scanFeeLogs: async () => [],
    });
    expect(result.reconciled).toBe(1);
    expect(store.getCharge("x1")!.status).toBe("failed"); // reservation released
  });

  test("a fiat charge landing during the estimate gap is re-validated before broadcast", async () => {
    const { store, relayer, deps } = mkWorld();
    const issued = await mkCard(store); // 25 USDC period cap
    relayer.onEstimate = () => {
      // the Stripe webhook approves + inserts during the crypto spend's await gap
      // (its decide+insert is sync-atomic and never takes the spend mutex)
      store.insertCharge({
        id: "visa1", card_id: issued.cardId, idempotency_key: "stripe-evt", kind: "admin",
        to_addr: null, amount_atoms: 20_000_000n, fee_atoms: 0n, request_id: "iauth_x",
        tx_hash: null, status: "confirmed", memo: "visa-sim", created_at: NOW,
      });
    };
    await expect(
      spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 10_000_000n }),
    ).rejects.toMatchObject({ code: "over_period_limit" });
    expect(relayer.calls.sends.length).toBe(0); // refused BEFORE broadcast
  });

  test("KeyedMutex serializes same-key sections; concurrent spends cannot double-approve", async () => {
    // plain ordering
    const mutex = new KeyedMutex();
    const order: number[] = [];
    await Promise.all([
      mutex.run("k", async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
      mutex.run("k", async () => { order.push(2); }),
      mutex.run("other", async () => { order.push(0); }), // different key: runs first
    ]);
    expect(order).toEqual([0, 1, 2]);
    // a throw doesn't wedge the key
    await expect(mutex.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(mutex.run("k", async () => "alive")).resolves.toBe("alive");

    // two concurrent 13-USDC spends against a 25 cap: serialized, the second refuses
    const { store, deps } = mkWorld();
    const issued = await mkCard(store);
    const m2 = new KeyedMutex();
    const spendOnce = () =>
      m2.run(issued.cardId, () =>
        spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 13_000_000n }),
      );
    const [a, b] = await Promise.allSettled([spendOnce(), spendOnce()]);
    const outcomes = [a, b].map((r) => r.status);
    expect(outcomes.filter((s) => s === "fulfilled").length).toBe(1);
    expect(outcomes.filter((s) => s === "rejected").length).toBe(1);
    const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe("over_period_limit");
  });
});

// ---------------------------------------------------------------------------
// #42: contract-mode allowance gates + multi-item pinning (FakeRelayer captures)
// ---------------------------------------------------------------------------

describe("execute: allowance pins + policy gates", () => {
  const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
  const USDC = CHAINS[8453].usdc;
  const WETH = "0x4200000000000000000000000000000000000006" as Address;
  const SWAP_SIG = "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))";
  const env = getSmartAccountsEnvironment(8453);
  const E = env.caveatEnforcers as Record<string, Address>;
  const lc = (a: string) => a.toLowerCase();

  const swapExec = (): WireExecution => ({
    target: ROUTER,
    value: "0",
    data: ("0x04e45aaf" + "0".repeat(448)) as `0x${string}`, // exactInputSingle selector + 7 words
  });

  const contractTerms = (extra?: Partial<NonNullable<CardTerms["contract"]>>): CardTerms => ({
    contract: { targets: [ROUTER], selectors: [SWAP_SIG], tokens: [USDC], perTradeMax: "0.05", ...extra },
  });

  async function mkContractWorld(terms?: CardTerms) {
    const { store, relayer, deps } = mkWorld();
    const issued = await issueRootCard(
      { store, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
      { userId: "u1", name: "swap card", terms: terms ?? contractTerms() },
    );
    return { store, relayer, deps, issued };
  }

  test("approve+swap: approve isolated in a pinned item, swap+fee ride the second", async () => {
    const { relayer, deps, issued } = await mkContractWorld();
    const receipt = await spend(deps, issued.cardId, {
      kind: "execute",
      mode: "contract",
      workExecutions: [erc20ApproveExecution(USDC, ROUTER, 30_000n), swapExec()],
    });
    expect(receipt.status).toBe("confirmed");
    const sent = relayer.calls.sends[0]!;
    expect(sent.length).toBe(2);
    // item 0: the pinned approve, alone
    expect(sent[0]!.executions.length).toBe(1);
    expect(lc(sent[0]!.executions[0]!.target)).toBe(lc(USDC));
    const pinned = sent[0]!.permissionContext[0]!;
    const pins = pinned.caveats.filter((c) => lc(c.enforcer) === lc(E.AllowedCalldataEnforcer!));
    expect(pins.length).toBe(2);
    expect(lc(pins[0]!.terms)).toContain(lc(ROUTER).slice(2)); // spender pin
    expect(BigInt("0x" + pins[1]!.terms.slice(-64))).toBe(30_000n); // exact amount pin
    // pinned leaf scope: ONLY the token target + approve method
    const targets = pinned.caveats.find((c) => lc(c.enforcer) === lc(E.AllowedTargetsEnforcer!))!;
    expect(lc(targets.terms)).toBe(lc(USDC));
    // item 1: swap + fee, behind the normal contract leaf (no calldata pins)
    expect(sent[1]!.executions.length).toBe(2);
    expect(sent[1]!.permissionContext[0]!.caveats.filter((c) => lc(c.enforcer) === lc(E.AllowedCalldataEnforcer!)).length).toBe(0);
    // both items share the same signed root
    expect(sent[0]!.permissionContext[1]!.signature).toBe(sent[1]!.permissionContext[1]!.signature);
  });

  test("approve-only batch: pinned item + fee in its own item", async () => {
    const { relayer, deps, issued } = await mkContractWorld();
    await spend(deps, issued.cardId, {
      kind: "execute",
      mode: "contract",
      workExecutions: [erc20ApproveExecution(USDC, ROUTER, 1_000n)],
    });
    const sent = relayer.calls.sends[0]!;
    expect(sent.length).toBe(2);
    expect(sent[0]!.executions.length).toBe(1); // approve alone
    expect(sent[1]!.executions.length).toBe(1); // fee alone, unpinned leaf
  });

  test("no-allowance batch keeps the proven single-item shape", async () => {
    const { relayer, deps, issued } = await mkContractWorld({
      contract: { targets: [ROUTER], selectors: [SWAP_SIG] },
    });
    await spend(deps, issued.cardId, { kind: "execute", mode: "contract", workExecutions: [swapExec()] });
    const sent = relayer.calls.sends[0]!;
    expect(sent.length).toBe(1);
    expect(sent[0]!.executions.length).toBe(2); // swap + fee
  });

  test("pay mode unchanged: one item, [work, fee]", async () => {
    const { relayer, deps } = mkWorld();
    const { store } = { store: deps.store };
    const issued = await mkCard(deps.store);
    await spend(deps, issued.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000_000n });
    const sent = relayer.calls.sends[0]!;
    expect(sent.length).toBe(1);
    expect(sent[0]!.executions.length).toBe(2);
    void store;
  });

  test("spender outside scope -> spender_not_allowed (no send)", async () => {
    const { relayer, deps, issued } = await mkContractWorld();
    await expect(
      spend(deps, issued.cardId, {
        kind: "execute",
        mode: "contract",
        workExecutions: [erc20ApproveExecution(USDC, OTHER, 1_000n)],
      }),
    ).rejects.toMatchObject({ code: "spender_not_allowed" });
    expect(relayer.calls.sends.length).toBe(0);
  });

  test("token off the list -> token_not_allowed", async () => {
    // WETH callable (declared target with approve unioned via tokens) but NOT a listed allowance token
    const { deps, issued } = await mkContractWorld(
      contractTerms({ targets: [ROUTER, WETH], tokens: [USDC] }),
    );
    await expect(
      spend(deps, issued.cardId, {
        kind: "execute",
        mode: "contract",
        workExecutions: [erc20ApproveExecution(WETH, ROUTER, 1n)],
      }),
    ).rejects.toMatchObject({ code: "token_not_allowed" });
  });

  test("USDC allowance above perTradeMax -> per_trade_exceeded; at the cap passes", async () => {
    const { deps, issued } = await mkContractWorld();
    await expect(
      spend(deps, issued.cardId, {
        kind: "execute",
        mode: "contract",
        workExecutions: [erc20ApproveExecution(USDC, ROUTER, 50_001n)],
      }),
    ).rejects.toMatchObject({ code: "per_trade_exceeded" });
    const ok = await spend(deps, issued.cardId, {
      kind: "execute",
      mode: "contract",
      workExecutions: [erc20ApproveExecution(USDC, ROUTER, 50_000n)],
    });
    expect(ok.status).toBe("confirmed");
  });

  test("ancestor gates bind the subtree: parent's token list refuses a sub-card approve", async () => {
    const { store, deps, issued } = await mkContractWorld(
      contractTerms({ targets: [ROUTER, WETH], tokens: [USDC] }),
    );
    // child declares its own tokens [USDC] (subset ok) but tries a WETH approve at spend
    const sub = await issueSubCard(
      { store, now: () => NOW + 10 },
      { parentCardId: issued.cardId, name: "sub", terms: { contract: { targets: [ROUTER, WETH], selectors: [SWAP_SIG], tokens: [USDC] } } },
    );
    await expect(
      spend(deps, sub.cardId, {
        kind: "execute",
        mode: "contract",
        workExecutions: [erc20ApproveExecution(WETH, ROUTER, 1n)],
      }),
    ).rejects.toMatchObject({ code: "token_not_allowed" });
  });

  test("malformed allowance calldata refused before any relayer traffic", async () => {
    const { relayer, deps, issued } = await mkContractWorld();
    await expect(
      spend(deps, issued.cardId, {
        kind: "execute",
        mode: "contract",
        workExecutions: [{ target: USDC, value: "0", data: ("0x095ea7b3" + "00".repeat(70)) as `0x${string}` }],
      }),
    ).rejects.toMatchObject({ code: "invalid_terms" });
    expect(relayer.calls.estimates.length).toBe(0);
  });
});
