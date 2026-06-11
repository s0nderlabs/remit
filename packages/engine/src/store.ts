// bun:sqlite store: users, cards, charges + the accounting math.
//
// ACCOUNTING LAW: the chain enforces EVERY ancestor's caveats on EVERY descendant
// spend (DelegationManager walks the whole chain), and the erc20PeriodTransfer /
// erc20TransferAmount enforcers count the FEE leg too (it is a USDC transfer from
// A_user under the same root). So:
//   - spend accounting sums (amount + fee) over the card's whole SUBTREE,
//   - period windows are FIXED (reset at startDate + k*duration), not rolling,
// or the server would approve what the chain rejects.

import { Database } from "bun:sqlite";
import type { Address, Hex } from "viem";
import type { CardKind, CardTerms, CompiledCard, WireDelegation } from "./types";

// ---------------------------------------------------------------------------
// Period window math (mirrors ERC20PeriodTransferEnforcer)
// ---------------------------------------------------------------------------

export type PeriodWindow = { start: number; resetsAt: number };

export function periodWindow(startDate: number, periodSeconds: number, now: number): PeriodWindow {
  if (now < startDate) return { start: startDate, resetsAt: startDate + periodSeconds };
  const k = Math.floor((now - startDate) / periodSeconds);
  const start = startDate + k * periodSeconds;
  return { start, resetsAt: start + periodSeconds };
}

// ---------------------------------------------------------------------------
// Compiled-card serde (bigints <-> strings)
// ---------------------------------------------------------------------------

export function serializeCompiled(c: CompiledCard): string {
  return JSON.stringify({
    ...c,
    orGroups: c.orGroups
      ? { ...c.orGroups, payIndex: c.orGroups.payIndex.toString(), contractIndex: c.orGroups.contractIndex.toString() }
      : null,
    carvePolicy: {
      perTxMaxAtoms: c.carvePolicy.perTxMaxAtoms?.toString() ?? null,
      merchants: c.carvePolicy.merchants,
    },
  });
}

export function deserializeCompiled(json: string): CompiledCard {
  const raw = JSON.parse(json);
  return {
    ...raw,
    orGroups: raw.orGroups
      ? { ...raw.orGroups, payIndex: BigInt(raw.orGroups.payIndex), contractIndex: BigInt(raw.orGroups.contractIndex) }
      : null,
    carvePolicy: {
      perTxMaxAtoms: raw.carvePolicy.perTxMaxAtoms !== null ? BigInt(raw.carvePolicy.perTxMaxAtoms) : null,
      merchants: raw.carvePolicy.merchants,
    },
  };
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type CardStatus = "active" | "frozen" | "revoked" | "nuked";
// "settlement_unconfirmed": served but the seller echoed no on-chain proof (x402 bare 200).
// Counts against budget (reservation held) but is NOT a proven on-chain settlement; kept
// distinct from "confirmed" so the ledger never claims a confirmation the receipt disclaims.
export type ChargeStatus = "pending" | "confirmed" | "failed" | "settlement_unconfirmed";
export type ChargeKind = "pay" | "x402" | "execute" | "admin" | "fiat";

export type UserRow = {
  id: string;
  address: Address;
  auth7702_json: string | null; // signed 7702 authorization, wire shape
  revocation_nonce: string; // decimal string of the user's current NonceEnforcer nonce
  /** Privy DID (did:privy:...) bound to this wallet at onboard; null = never Privy-onboarded */
  privy_did: string | null;
  created_at: number;
};

export type CardRow = {
  id: string;
  user_id: string;
  parent_card_id: string | null;
  name: string;
  secret_hash: string;
  /** envelope-encrypted bearer secret (URL re-view is a locked feature) */
  secret_enc: Uint8Array | null;
  terms: CardTerms;
  kind: CardKind;
  compiled: CompiledCard;
  delegation: WireDelegation; // THIS card's signed delegation (root or child)
  k_agent_enc: Uint8Array;
  k_agent_address: Address;
  status: CardStatus;
  created_at: number;
};

export type ChargeRow = {
  id: string;
  card_id: string;
  idempotency_key: string | null;
  kind: ChargeKind;
  to_addr: Address | null;
  amount_atoms: bigint;
  fee_atoms: bigint;
  request_id: string | null;
  tx_hash: Hex | null;
  status: ChargeStatus;
  memo: string | null;
  created_at: number;
  /** chain head captured at broadcast: the reconcile fee-leg scan starts here, so a
   * landed log is never missed no matter how long the reconcile sweep was down. */
  since_block?: string | null;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  readonly db: Database;

  constructor(path: string = process.env.REMIT_DB_PATH ?? ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        auth7702_json TEXT,
        revocation_nonce TEXT NOT NULL DEFAULT '0',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        parent_card_id TEXT REFERENCES cards(id),
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        secret_enc BLOB,
        terms_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        compiled_json TEXT NOT NULL,
        delegation_json TEXT NOT NULL,
        k_agent_enc BLOB NOT NULL,
        k_agent_address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
      CREATE INDEX IF NOT EXISTS idx_cards_parent ON cards(parent_card_id);
      CREATE TABLE IF NOT EXISTS charges (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        idempotency_key TEXT,
        kind TEXT NOT NULL,
        to_addr TEXT,
        amount_atoms TEXT NOT NULL,
        fee_atoms TEXT NOT NULL,
        request_id TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL,
        memo TEXT,
        created_at INTEGER NOT NULL,
        since_block TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_charges_card ON charges(card_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_idem
        ON charges(card_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
    // additive migration for DBs created before secret_enc existed
    const cols = this.db.query(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "secret_enc")) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN secret_enc BLOB`);
    }
    // additive migration for DBs created before the Privy-session binding existed
    const userCols = this.db.query(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!userCols.some((c) => c.name === "privy_did")) {
      this.db.exec(`ALTER TABLE users ADD COLUMN privy_did TEXT`);
    }
    // additive migration for DBs created before the reconcile fee-leg scan anchor existed
    const chargeCols = this.db.query(`PRAGMA table_info(charges)`).all() as Array<{ name: string }>;
    if (!chargeCols.some((c) => c.name === "since_block")) {
      this.db.exec(`ALTER TABLE charges ADD COLUMN since_block TEXT`);
    }
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_privy_did ON users(privy_did) WHERE privy_did IS NOT NULL`,
    );
  }

  // ---- users ----

  upsertUser(u: { id: string; address: Address; auth7702Json?: string | null; privyDid?: string | null }): void {
    this.db
      .query(
        `INSERT INTO users (id, address, auth7702_json, privy_did, created_at)
         VALUES ($id, $address, $auth, $did, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           auth7702_json = COALESCE($auth, auth7702_json),
           privy_did = COALESCE($did, privy_did)`,
      )
      .run({ $id: u.id, $address: u.address, $auth: u.auth7702Json ?? null, $did: u.privyDid ?? null });
  }

  getUser(id: string): UserRow | null {
    return (this.db.query(`SELECT * FROM users WHERE id = $id`).get({ $id: id }) as UserRow) ?? null;
  }

  getUserByPrivyDid(did: string): UserRow | null {
    return (
      (this.db.query(`SELECT * FROM users WHERE privy_did = $d`).get({ $d: did }) as UserRow) ?? null
    );
  }

  getUserByAddress(address: Address): UserRow | null {
    return (
      (this.db
        .query(`SELECT * FROM users WHERE address = $a COLLATE NOCASE`)
        .get({ $a: address }) as UserRow) ?? null
    );
  }

  setRevocationNonce(userId: string, nonce: bigint): void {
    this.db
      .query(`UPDATE users SET revocation_nonce = $n WHERE id = $id`)
      .run({ $n: nonce.toString(), $id: userId });
  }

  // ---- cards ----

  createCard(c: CardRow): void {
    this.db
      .query(
        `INSERT INTO cards (id, user_id, parent_card_id, name, secret_hash, secret_enc, terms_json, kind,
                            compiled_json, delegation_json, k_agent_enc, k_agent_address, status, created_at)
         VALUES ($id, $user, $parent, $name, $hash, $senc, $terms, $kind, $compiled, $delegation, $kenc, $kaddr, $status, $created)`,
      )
      .run({
        $id: c.id,
        $user: c.user_id,
        $parent: c.parent_card_id,
        $name: c.name,
        $hash: c.secret_hash,
        $senc: c.secret_enc,
        $terms: JSON.stringify(c.terms),
        $kind: c.kind,
        $compiled: serializeCompiled(c.compiled),
        $delegation: JSON.stringify(c.delegation),
        $kenc: c.k_agent_enc,
        $kaddr: c.k_agent_address,
        $status: c.status,
        $created: c.created_at,
      });
  }

  private rowToCard(r: Record<string, unknown> | null): CardRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      user_id: r.user_id as string,
      parent_card_id: (r.parent_card_id as string) ?? null,
      name: r.name as string,
      secret_hash: r.secret_hash as string,
      secret_enc: r.secret_enc ? new Uint8Array(r.secret_enc as Uint8Array) : null,
      terms: JSON.parse(r.terms_json as string),
      kind: r.kind as CardKind,
      compiled: deserializeCompiled(r.compiled_json as string),
      delegation: JSON.parse(r.delegation_json as string),
      k_agent_enc: new Uint8Array(r.k_agent_enc as Uint8Array),
      k_agent_address: r.k_agent_address as Address,
      status: r.status as CardStatus,
      created_at: r.created_at as number,
    };
  }

  getCard(id: string): CardRow | null {
    return this.rowToCard(this.db.query(`SELECT * FROM cards WHERE id = $id`).get({ $id: id }) as never);
  }

  getCardBySecretHash(hash: string): CardRow | null {
    return this.rowToCard(
      this.db.query(`SELECT * FROM cards WHERE secret_hash = $h`).get({ $h: hash }) as never,
    );
  }

  listCards(userId: string): CardRow[] {
    const rows = this.db.query(`SELECT * FROM cards WHERE user_id = $u ORDER BY created_at`).all({ $u: userId }) as never[];
    return rows.map((r) => this.rowToCard(r)!) ;
  }

  listChildren(parentCardId: string): CardRow[] {
    const rows = this.db
      .query(`SELECT * FROM cards WHERE parent_card_id = $p ORDER BY created_at`)
      .all({ $p: parentCardId }) as never[];
    return rows.map((r) => this.rowToCard(r)!);
  }

  /** The card and ALL its descendants (recursive). */
  subtreeIds(cardId: string): string[] {
    const rows = this.db
      .query(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM cards WHERE id = $id
           UNION ALL
           SELECT c.id FROM cards c JOIN sub s ON c.parent_card_id = s.id
         ) SELECT id FROM sub`,
      )
      .all({ $id: cardId }) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Ancestor chain card rows, this card FIRST, root LAST (the permissionContext order). */
  ancestorChain(cardId: string): CardRow[] {
    const chain: CardRow[] = [];
    let cur = this.getCard(cardId);
    while (cur) {
      chain.push(cur);
      cur = cur.parent_card_id ? this.getCard(cur.parent_card_id) : null;
    }
    return chain;
  }

  setCardStatus(cardId: string, status: CardStatus): void {
    this.db.query(`UPDATE cards SET status = $s WHERE id = $id`).run({ $s: status, $id: cardId });
  }

  /** Hard-delete a card and its whole subtree, charge history included. Pure
   * bookkeeping removal for DEAD trees: callers enforce the status guard.
   * Children go before parents (foreign_keys = ON) · subtreeIds is root-first,
   * so the card delete walks it in reverse. */
  deleteCardTree(cardId: string): number {
    const ids = this.subtreeIds(cardId);
    if (ids.length === 0) return 0;
    const delCharges = this.db.query(`DELETE FROM charges WHERE card_id = $id`);
    const delCard = this.db.query(`DELETE FROM cards WHERE id = $id`);
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) delCharges.run({ $id: id });
      for (const id of [...items].reverse()) delCard.run({ $id: id });
    });
    tx(ids);
    return ids.length;
  }

  /** Status update for a whole subtree (revoke kills descendants too). */
  setSubtreeStatus(cardId: string, status: CardStatus): void {
    const ids = this.subtreeIds(cardId);
    const q = this.db.query(`UPDATE cards SET status = $s WHERE id = $id`);
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) q.run({ $s: status, $id: id });
    });
    tx(ids);
  }

  /** Nuke: every card belonging to the user dies (NonceEnforcer bump kills them all on-chain). */
  setAllUserCardsStatus(userId: string, status: CardStatus): void {
    this.db.query(`UPDATE cards SET status = $s WHERE user_id = $u`).run({ $s: status, $u: userId });
  }

  rotateSecret(cardId: string, newHash: string, newSecretEnc: Uint8Array | null = null): void {
    this.db
      .query(`UPDATE cards SET secret_hash = $h, secret_enc = $e WHERE id = $id`)
      .run({ $h: newHash, $e: newSecretEnc, $id: cardId });
  }

  // ---- charges ----

  insertCharge(ch: ChargeRow): void {
    this.db
      .query(
        `INSERT INTO charges (id, card_id, idempotency_key, kind, to_addr, amount_atoms, fee_atoms,
                              request_id, tx_hash, status, memo, created_at, since_block)
         VALUES ($id, $card, $idem, $kind, $to, $amount, $fee, $req, $tx, $status, $memo, $created, $since)`,
      )
      .run({
        $id: ch.id,
        $card: ch.card_id,
        $idem: ch.idempotency_key,
        $kind: ch.kind,
        $to: ch.to_addr,
        $amount: ch.amount_atoms.toString(),
        $fee: ch.fee_atoms.toString(),
        $req: ch.request_id,
        $tx: ch.tx_hash,
        $status: ch.status,
        $memo: ch.memo,
        $created: ch.created_at,
        $since: ch.since_block ?? null,
      });
  }

  updateCharge(id: string, fields: { status?: ChargeStatus; tx_hash?: Hex; request_id?: string; fee_atoms?: bigint; since_block?: bigint }): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { $id: id };
    if (fields.status !== undefined) { sets.push("status = $status"); params.$status = fields.status; }
    if (fields.tx_hash !== undefined) { sets.push("tx_hash = $tx"); params.$tx = fields.tx_hash; }
    if (fields.request_id !== undefined) { sets.push("request_id = $req"); params.$req = fields.request_id; }
    if (fields.fee_atoms !== undefined) { sets.push("fee_atoms = $fee"); params.$fee = fields.fee_atoms.toString(); }
    if (fields.since_block !== undefined) { sets.push("since_block = $since"); params.$since = fields.since_block.toString(); }
    if (!sets.length) return;
    this.db.query(`UPDATE charges SET ${sets.join(", ")} WHERE id = $id`).run(params as never);
  }

  private rowToCharge(r: Record<string, unknown> | null): ChargeRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      card_id: r.card_id as string,
      idempotency_key: (r.idempotency_key as string) ?? null,
      kind: r.kind as ChargeKind,
      to_addr: (r.to_addr as Address) ?? null,
      amount_atoms: BigInt(r.amount_atoms as string),
      fee_atoms: BigInt(r.fee_atoms as string),
      request_id: (r.request_id as string) ?? null,
      tx_hash: (r.tx_hash as Hex) ?? null,
      status: r.status as ChargeStatus,
      memo: (r.memo as string) ?? null,
      created_at: r.created_at as number,
      since_block: (r.since_block as string) ?? null,
    };
  }

  getCharge(id: string): ChargeRow | null {
    return this.rowToCharge(this.db.query(`SELECT * FROM charges WHERE id = $id`).get({ $id: id }) as never);
  }

  deleteCharge(id: string): void {
    this.db.query(`DELETE FROM charges WHERE id = $id`).run({ $id: id });
  }

  /** Pending charges that were broadcast (request_id set) but never confirmed, older
   * than `before`. The reconcile sweep settles these against chain logs. */
  pendingChargesOlderThan(before: number): ChargeRow[] {
    const rows = this.db
      .query(`SELECT * FROM charges WHERE status = 'pending' AND request_id IS NOT NULL AND created_at < $t`)
      .all({ $t: before }) as never[];
    return rows.map((r) => this.rowToCharge(r)!);
  }

  /** x402 reservations orphaned 'pending' (request_id IS NULL: never reached a relayer
   * broadcast · the inline finalize was lost to a process restart or an unhandled throw),
   * older than `before`. The reconcile sweep frees these so a dead reservation can't hold
   * a card's budget forever. x402 settlement is the seller's, so there is no fee-leg log
   * of ours to match · a long-stale reservation is conservatively released. */
  pendingX402ChargesOlderThan(before: number): ChargeRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM charges WHERE status = 'pending' AND kind = 'x402' AND request_id IS NULL AND created_at < $t`,
      )
      .all({ $t: before }) as never[];
    return rows.map((r) => this.rowToCharge(r)!);
  }

  /** Fiat authorizations awaiting settlement: 'pending' fiat rows that never reached a
   * relayer broadcast (request_id IS NULL), older than `before`. The settlement
   * executor's sweep re-drives these through spend(); they are intentionally invisible
   * to reconcilePending (which requires request_id NOT NULL). */
  unsettledFiatCharges(before: number): ChargeRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM charges WHERE status = 'pending' AND kind = 'fiat' AND request_id IS NULL AND created_at < $t`,
      )
      .all({ $t: before }) as never[];
    return rows.map((r) => this.rowToCharge(r)!);
  }

  chargeByIdempotency(cardId: string, key: string): ChargeRow | null {
    return this.rowToCharge(
      this.db
        .query(`SELECT * FROM charges WHERE card_id = $c AND idempotency_key = $k`)
        .get({ $c: cardId, $k: key }) as never,
    );
  }

  listCharges(cardId: string, limit = 20): ChargeRow[] {
    const rows = this.db
      .query(`SELECT * FROM charges WHERE card_id = $c ORDER BY created_at DESC LIMIT $l`)
      .all({ $c: cardId, $l: limit }) as never[];
    return rows.map((r) => this.rowToCharge(r)!);
  }

  // ---- accounting (amount + fee, pending counts, SUBTREE-wide) ----

  /** Sum of (amount + fee) atoms across the card's subtree since `windowStart` (pending + confirmed). */
  subtreeSpentSince(cardId: string, windowStart: number): bigint {
    const ids = this.subtreeIds(cardId);
    const placeholders = ids.map((_, i) => `$c${i}`).join(",");
    const params: Record<string, unknown> = { $start: windowStart };
    ids.forEach((id, i) => (params[`$c${i}`] = id));
    const rows = this.db
      .query(
        `SELECT amount_atoms, fee_atoms FROM charges
         WHERE card_id IN (${placeholders}) AND status != 'failed' AND created_at >= $start`,
      )
      .all(params as never) as Array<{ amount_atoms: string; fee_atoms: string }>;
    return rows.reduce((acc, r) => acc + BigInt(r.amount_atoms) + BigInt(r.fee_atoms), 0n);
  }

  /** Lifetime (amount + fee) atoms across the subtree. */
  subtreeSpentLifetime(cardId: string): bigint {
    return this.subtreeSpentSince(cardId, 0);
  }

  /** Number of non-failed redemptions through THIS card only (display). */
  usesCount(cardId: string): number {
    const r = this.db
      .query(`SELECT COUNT(*) AS n FROM charges WHERE card_id = $c AND status != 'failed'`)
      .get({ $c: cardId }) as { n: number };
    return r.n;
  }

  /** limitedCalls MIRROR: a card's delegation rides every DESCENDANT's chain too, so the
   * on-chain LimitedCallsEnforcer counts subtree redemptions. Validate against this. */
  subtreeUsesCount(cardId: string): number {
    const ids = this.subtreeIds(cardId);
    const placeholders = ids.map((_, i) => `$c${i}`).join(",");
    const params: Record<string, unknown> = {};
    ids.forEach((id, i) => (params[`$c${i}`] = id));
    const r = this.db
      .query(`SELECT COUNT(*) AS n FROM charges WHERE card_id IN (${placeholders}) AND status != 'failed'`)
      .get(params as never) as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}
