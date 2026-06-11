// Fiat settlement executor tests: the engine's settle mode re-drives the
// webhook-booked fiat row through the spend pipeline against a fake relayer (zero
// network). Covers the retry/backoff ladder and the never-"failed" invariant:
// terminal problems park the row settlement_unconfirmed and freeze the card.

import { beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
  CHAINS,
  KeyedMutex,
  Store,
  freezeCard,
  issueRootCard,
  unfreezeCard,
  type EstimateResult,
  type Relayer,
  type RelayerTransaction,
} from "@remit/engine";
import type { AppDeps } from "../src/deps";
import { makeFiatSettler } from "../src/stripe/settlement";

const NOW = 1_780_000_000;
const SETTLE_TO = "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address;

const user = privateKeyToAccount(generatePrivateKey());

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "d".repeat(64);
});

class FakeRelayer {
  calls = { estimates: 0, sends: 0 };
  /** throw this many estimates before succeeding (relayer/network blips) */
  estimateThrows = 0;
  async getFeeData() {
    return { minFee: "0.01", rate: 1598, gasPrice: "1", expiry: NOW + 600, feeCollector: SETTLE_TO, targetAddress: CHAINS[8453].targetAddress, context: "ctx" };
  }
  async getCapabilities() {
    return { targetAddress: CHAINS[8453].targetAddress, feeCollector: SETTLE_TO, tokens: [] };
  }
  async estimate(_tx: RelayerTransaction[]): Promise<EstimateResult> {
    this.calls.estimates++;
    if (this.estimateThrows > 0) {
      this.estimateThrows--;
      throw new Error("relayer 502");
    }
    return { success: true, requiredPaymentAmount: "10000", context: "ctx-ok", error: null, raw: null };
  }
  async send(): Promise<string> {
    this.calls.sends++;
    return "0xrequestid";
  }
  async getStatus() {
    return { status: 200, txHash: "0xsettled" as `0x${string}`, raw: null };
  }
  async waitForStatus() {
    return { status: 200, txHash: "0xsettled" as `0x${string}`, raw: null, timedOut: false };
  }
}

async function mkWorld() {
  const store = new Store(":memory:");
  store.upsertUser({ id: "u-settle", address: user.address });
  const relayer = new FakeRelayer();
  const deps: AppDeps = {
    store,
    relayer: relayer as unknown as Relayer,
    userSigner: user,
    adminToken: null,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    spendOverrides: { now: () => NOW + 60, codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
  };
  const issued = await issueRootCard(
    { store, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
    { userId: "u-settle", name: "fiat-settle card", terms: { pay: { period: { amount: "10", seconds: 604800 } } } },
  );
  return { store, relayer, deps, cardId: issued.cardId };
}

/** The exact row shape the webhook books in settlement mode: pending, never broadcast. */
function insertFiatRow(store: Store, cardId: string, id: string, createdAt = NOW): void {
  store.insertCharge({
    id, card_id: cardId, idempotency_key: `stripe-${id}`, kind: "fiat",
    to_addr: SETTLE_TO, amount_atoms: 4_000_000n, fee_atoms: 0n, request_id: null,
    tx_hash: null, status: "pending", memo: `visa · test merchant · ${id} (in_budget)`, created_at: createdAt,
  });
}

const instant = { backoffMs: [0, 0, 0], sleep: async () => {} };

describe("settle()", () => {
  test("happy path: the webhook's row itself flips to confirmed with a real tx hash", async () => {
    const { store, relayer, deps, cardId } = await mkWorld();
    insertFiatRow(store, cardId, "ch-happy");
    await makeFiatSettler(deps, instant).settle("ch-happy");
    const row = store.getCharge("ch-happy")!;
    expect(row.status).toBe("confirmed");
    expect(row.tx_hash).toBe("0xsettled");
    expect(row.fee_atoms).toBe(10_000n); // the settlement leg's relayer fee joins the row
    expect(relayer.calls.sends).toBe(1);
    expect(store.listCharges(cardId).length).toBe(1); // SAME row driven, no second charge
    expect(store.getCard(cardId)!.status).toBe("active"); // nothing froze
  });

  test("two overlapping settle() calls broadcast exactly once (claim under the mutex)", async () => {
    const { store, relayer, deps, cardId } = await mkWorld();
    insertFiatRow(store, cardId, "ch-race");
    const settler = makeFiatSettler(deps, instant);
    // both pass the pre-mutex pending check; the in-spend claim/request_id re-read
    // under the mutex must keep the second from re-broadcasting
    await Promise.all([settler.settle("ch-race"), settler.settle("ch-race")]);
    expect(relayer.calls.sends).toBe(1);
    expect(store.getCharge("ch-race")!.status).toBe("confirmed");
  });

  test("relayer blip retries under backoff and then settles", async () => {
    const { store, relayer, deps, cardId } = await mkWorld();
    insertFiatRow(store, cardId, "ch-retry");
    relayer.estimateThrows = 1;
    await makeFiatSettler(deps, instant).settle("ch-retry");
    expect(store.getCharge("ch-retry")!.status).toBe("confirmed");
    expect(relayer.calls.estimates).toBe(2); // first threw, second carried the send
    expect(relayer.calls.sends).toBe(1);
  });

  test("exhausted retries park the row settlement_unconfirmed (never failed) and freeze the card", async () => {
    const { store, relayer, deps, cardId } = await mkWorld();
    insertFiatRow(store, cardId, "ch-dead");
    relayer.estimateThrows = 99; // every attempt blips
    await makeFiatSettler(deps, instant).settle("ch-dead");
    const row = store.getCharge("ch-dead")!;
    expect(row.status).toBe("settlement_unconfirmed"); // budget stays held, NOT failed
    expect(relayer.calls.sends).toBe(0);
    expect(store.getCard(cardId)!.status).toBe("frozen"); // held for ops eyes
  });

  test("card_frozen leaves the row pending (no park, no freeze-loop); unfreeze resumes", async () => {
    const { store, relayer, deps, cardId } = await mkWorld();
    insertFiatRow(store, cardId, "ch-frozen");
    freezeCard(store, cardId);
    const settler = makeFiatSettler(deps, instant);
    await settler.settle("ch-frozen");
    expect(store.getCharge("ch-frozen")!.status).toBe("pending"); // awaits an unfreeze
    expect(store.getCard(cardId)!.status).toBe("frozen");
    expect(relayer.calls.estimates).toBe(0); // refused before any relayer traffic

    unfreezeCard(store, cardId);
    await settler.settle("ch-frozen");
    expect(store.getCharge("ch-frozen")!.status).toBe("confirmed");
  });
});

describe("sweep()", () => {
  test("picks up an aged unsettled row and settles it; fresh rows wait for the inline kickoff", async () => {
    const { store, deps, cardId } = await mkWorld();
    const nowS = Math.floor(Date.now() / 1000);
    insertFiatRow(store, cardId, "ch-aged", nowS - 120);
    insertFiatRow(store, cardId, "ch-fresh", nowS); // younger than the sweep min-age
    const result = await makeFiatSettler(deps, instant).sweep();
    expect(result).toEqual({ settled: 1, left: 0 });
    expect(store.getCharge("ch-aged")!.status).toBe("confirmed");
    expect(store.getCharge("ch-fresh")!.status).toBe("pending");
  });

  test("a frozen card's row counts as left and survives for the next sweep", async () => {
    const { store, deps, cardId } = await mkWorld();
    insertFiatRow(store, cardId, "ch-wait", Math.floor(Date.now() / 1000) - 120);
    freezeCard(store, cardId);
    const result = await makeFiatSettler(deps, instant).sweep();
    expect(result).toEqual({ settled: 0, left: 1 });
    expect(store.getCharge("ch-wait")!.status).toBe("pending");
  });
});
