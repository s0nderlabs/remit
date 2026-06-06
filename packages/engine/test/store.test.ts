import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { Store, periodWindow, serializeCompiled, deserializeCompiled } from "../src/store";
import { compileCard } from "../src/compiler";
import type { CardRow, ChargeRow } from "../src/store";

const NOW = 1_780_000_000;
const USER = { id: "u1", address: "0x5117715db9A94F66E56Cb564728615842DC07bba" as Address };

function mkStore(): Store {
  return new Store(":memory:");
}

function mkCard(store: Store, id: string, parent: string | null = null): CardRow {
  const compiled = compileCard(
    { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 },
    { revocationNonce: 0n, now: NOW },
  );
  const row: CardRow = {
    id,
    user_id: USER.id,
    parent_card_id: parent,
    name: `card-${id}`,
    secret_hash: `hash-${id}`,
    secret_enc: null,
    terms: compiled.terms,
    kind: compiled.kind,
    compiled,
    delegation: {
      delegate: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a" as Address,
      delegator: USER.address,
      authority: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      caveats: compiled.rootCaveats,
      salt: "0x01",
      signature: "0xsig" as never,
    },
    k_agent_enc: new Uint8Array([1, 2, 3]),
    k_agent_address: "0xa63F3E177F9f4EBAB827Fab93f7AFF8A3BAc6dD7" as Address,
    status: "active",
    created_at: NOW,
  };
  store.createCard(row);
  return row;
}

function mkCharge(store: Store, id: string, cardId: string, amount: bigint, at: number, status: ChargeRow["status"] = "confirmed"): void {
  store.insertCharge({
    id,
    card_id: cardId,
    idempotency_key: null,
    kind: "pay",
    to_addr: "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address,
    amount_atoms: amount,
    fee_atoms: 10_000n,
    request_id: null,
    tx_hash: null,
    status,
    memo: null,
    created_at: at,
  });
}

describe("periodWindow (enforcer mirror: fixed windows, not rolling)", () => {
  const start = 1_000_000;
  const period = 604_800;
  test("first window", () => {
    expect(periodWindow(start, period, start + 1)).toEqual({ start, resetsAt: start + period });
  });
  test("k-th window boundary math", () => {
    const w = periodWindow(start, period, start + period * 3 + 5);
    expect(w.start).toBe(start + period * 3);
    expect(w.resetsAt).toBe(start + period * 4);
  });
  test("exact boundary belongs to the NEW window", () => {
    const w = periodWindow(start, period, start + period);
    expect(w.start).toBe(start + period);
  });
});

describe("compiled serde", () => {
  test("composite card round-trips bigints", () => {
    const compiled = compileCard(
      {
        pay: { period: { amount: "25", seconds: 604800 } },
        contract: { targets: ["0x2626664c2603336E57B271c5C0b26F421741e481" as Address], selectors: ["approve(address,uint256)"] },
        perTxMax: "5",
      },
      { revocationNonce: 7n, now: NOW },
    );
    const back = deserializeCompiled(serializeCompiled(compiled));
    expect(back.orGroups!.payIndex).toBe(0n);
    expect(back.orGroups!.contractIndex).toBe(1n);
    expect(back.carvePolicy.perTxMaxAtoms).toBe(5_000_000n);
    expect(back.rootCaveats).toEqual(compiled.rootCaveats);
    expect(back.periodStartDate).toBe(compiled.periodStartDate);
  });
});

describe("store CRUD + tree", () => {
  test("cards round-trip including compiled + blob", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    const row = mkCard(s, "c1");
    const got = s.getCard("c1")!;
    expect(got.name).toBe(row.name);
    expect(got.compiled.kind).toBe("pay");
    expect(got.k_agent_enc).toEqual(new Uint8Array([1, 2, 3]));
    expect(s.getCardBySecretHash("hash-c1")!.id).toBe("c1");
  });

  test("subtree + ancestor chain ordering (leaf-first)", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    mkCard(s, "root");
    mkCard(s, "child", "root");
    mkCard(s, "grandchild", "child");
    mkCard(s, "other");
    expect(new Set(s.subtreeIds("root"))).toEqual(new Set(["root", "child", "grandchild"]));
    expect(s.ancestorChain("grandchild").map((c) => c.id)).toEqual(["grandchild", "child", "root"]);
  });

  test("status cascades: subtree revoke, user-wide nuke", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    mkCard(s, "root");
    mkCard(s, "child", "root");
    mkCard(s, "other");
    s.setSubtreeStatus("root", "revoked");
    expect(s.getCard("root")!.status).toBe("revoked");
    expect(s.getCard("child")!.status).toBe("revoked");
    expect(s.getCard("other")!.status).toBe("active");
    s.setAllUserCardsStatus(USER.id, "nuked");
    expect(s.getCard("other")!.status).toBe("nuked");
  });

  test("idempotency unique per card", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    mkCard(s, "c1");
    store_insert_with_idem(s, "ch1", "c1", "key1");
    expect(() => store_insert_with_idem(s, "ch2", "c1", "key1")).toThrow();
    expect(s.chargeByIdempotency("c1", "key1")!.id).toBe("ch1");
  });
});

function store_insert_with_idem(s: Store, id: string, cardId: string, key: string): void {
  s.insertCharge({
    id, card_id: cardId, idempotency_key: key, kind: "pay",
    to_addr: null, amount_atoms: 1n, fee_atoms: 1n, request_id: null,
    tx_hash: null, status: "pending", memo: null, created_at: NOW,
  });
}

describe("accounting (subtree-wide, fee-inclusive, fixed windows)", () => {
  test("subtree spend sums amounts + fees across descendants; failed excluded", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    mkCard(s, "root");
    mkCard(s, "child", "root");
    mkCharge(s, "a", "root", 1_000_000n, NOW); // 1 USDC + 0.01 fee
    mkCharge(s, "b", "child", 2_000_000n, NOW); // 2 USDC + 0.01 fee
    mkCharge(s, "c", "child", 9_000_000n, NOW, "failed"); // excluded
    mkCharge(s, "d", "child", 500_000n, NOW, "pending"); // pending COUNTS
    expect(s.subtreeSpentSince("root", 0)).toBe(1_000_000n + 2_000_000n + 500_000n + 3n * 10_000n);
    // child subtree only counts child's
    expect(s.subtreeSpentSince("child", 0)).toBe(2_000_000n + 500_000n + 2n * 10_000n);
  });

  test("window cutoff filters old charges", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    mkCard(s, "root");
    mkCharge(s, "old", "root", 5_000_000n, NOW - 10_000);
    mkCharge(s, "new", "root", 1_000_000n, NOW);
    expect(s.subtreeSpentSince("root", NOW - 100)).toBe(1_010_000n);
  });

  test("uses: own vs subtree (limitedCalls mirror)", () => {
    const s = mkStore();
    s.upsertUser({ id: USER.id, address: USER.address });
    mkCard(s, "root");
    mkCard(s, "child", "root");
    mkCharge(s, "a", "root", 1n, NOW);
    mkCharge(s, "b", "child", 1n, NOW);
    expect(s.usesCount("root")).toBe(1);
    expect(s.subtreeUsesCount("root")).toBe(2);
  });
});
