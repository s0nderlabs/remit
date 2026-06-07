// OAuth 2.1 storage for the MCP OAuth lane (fork B: remit self-hosts a minimal AS).
// Rides the SAME bun:sqlite database as the engine store; all rows are protocol
// plumbing, never money. Mirrors the card-secret custody rules:
//   - tokens/codes are opaque 256-bit base64url strings, prefixed (rmt_at_ / rmt_rt_)
//     so the /mcp bearer lane can disambiguate them from card secrets without a
//     second table probe,
//   - only the sha-256 hex digest is ever stored (theft of the DB yields nothing),
//   - revocation is store-side: delete/flag the row and the token dies on the next
//     /mcp lookup — independent of any client calling RFC 7009.
// Single process + synchronous sqlite = the UPDATE...WHERE guards below are atomic.

import type { Database } from "bun:sqlite";
import { hashCardSecret } from "@remit/engine";

const randomToken = (prefix: string): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Buffer.from(bytes).toString("base64url");
};

export type OAuthClientRow = {
  client_id: string;
  redirect_uris: string[];
  client_name: string | null;
  created_at: number;
};

export type OAuthRequestRow = {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string | null;
  state: string | null;
  /** the Privy user who first loaded the consent page for this request; null until
   * a logged-in user touches it. Claim-once: only that user may read/deny it after. */
  user_id: string | null;
  expires_at: number;
};

export type OAuthCodeRow = {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  card_id: string;
  user_id: string;
  resource: string | null;
  scope: string | null;
  used: number;
  expires_at: number;
};

export type OAuthTokenRow = {
  id: string;
  family_id: string;
  access_hash: string;
  refresh_hash: string | null;
  card_id: string;
  user_id: string;
  client_id: string;
  resource: string | null;
  scope: string | null;
  /** hash of the authorization code this family was minted from (replay -> revoke) */
  code_hash: string | null;
  access_expires_at: number;
  refresh_expires_at: number | null;
  revoked: number;
  created_at: number;
};

export const ACCESS_TOKEN_PREFIX = "rmt_at_";
export const REFRESH_TOKEN_PREFIX = "rmt_rt_";

export class OAuthStore {
  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        redirect_uris_json TEXT NOT NULL,
        client_name TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_requests (
        request_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT,
        scope TEXT,
        state TEXT,
        user_id TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        card_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        resource TEXT,
        scope TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        access_hash TEXT NOT NULL UNIQUE,
        refresh_hash TEXT UNIQUE,
        card_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        resource TEXT,
        scope TEXT,
        code_hash TEXT,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_card ON oauth_tokens(card_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_created ON oauth_tokens(created_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_clients_created ON oauth_clients(created_at);
    `);
    // additive migrations for DBs whose oauth tables predate later columns
    // (CREATE TABLE IF NOT EXISTS never alters an existing table)
    const addColumnIfMissing = (table: string, column: string, decl: string) => {
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    };
    addColumnIfMissing("oauth_requests", "user_id", "TEXT");
    addColumnIfMissing("oauth_tokens", "code_hash", "TEXT");
  }

  // ---- clients (DCR records) ----

  createClient(c: { redirectUris: string[]; clientName?: string | null }): OAuthClientRow {
    const clientId = `rmt_client_${crypto.randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `INSERT INTO oauth_clients (client_id, redirect_uris_json, client_name, created_at)
         VALUES ($id, $uris, $name, $created)`,
      )
      .run({ $id: clientId, $uris: JSON.stringify(c.redirectUris), $name: c.clientName ?? null, $created: createdAt });
    // opportunistic GC: registrations that never produced a token age out after 30 days
    this.db
      .query(
        `DELETE FROM oauth_clients WHERE created_at < $cutoff
           AND client_id NOT IN (SELECT DISTINCT client_id FROM oauth_tokens)`,
      )
      .run({ $cutoff: createdAt - 30 * 86_400 });
    return { client_id: clientId, redirect_uris: c.redirectUris, client_name: c.clientName ?? null, created_at: createdAt };
  }

  getClient(clientId: string): OAuthClientRow | null {
    const r = this.db.query(`SELECT * FROM oauth_clients WHERE client_id = $id`).get({ $id: clientId }) as
      | { client_id: string; redirect_uris_json: string; client_name: string | null; created_at: number }
      | null;
    if (!r) return null;
    return {
      client_id: r.client_id,
      redirect_uris: JSON.parse(r.redirect_uris_json),
      client_name: r.client_name,
      created_at: r.created_at,
    };
  }

  // ---- in-progress authorize requests (the consent window) ----

  createRequest(r: Omit<OAuthRequestRow, "request_id" | "expires_at" | "user_id">, ttlSeconds: number): string {
    const requestId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db.query(`DELETE FROM oauth_requests WHERE expires_at < $now`).run({ $now: now });
    this.db
      .query(
        `INSERT INTO oauth_requests (request_id, client_id, redirect_uri, code_challenge, resource, scope, state, expires_at)
         VALUES ($id, $client, $redirect, $challenge, $resource, $scope, $state, $expires)`,
      )
      .run({
        $id: requestId,
        $client: r.client_id,
        $redirect: r.redirect_uri,
        $challenge: r.code_challenge,
        $resource: r.resource,
        $scope: r.scope,
        $state: r.state,
        $expires: now + ttlSeconds,
      });
    return requestId;
  }

  getRequest(requestId: string): OAuthRequestRow | null {
    const r = this.db.query(`SELECT * FROM oauth_requests WHERE request_id = $id`).get({ $id: requestId }) as
      | OAuthRequestRow
      | null;
    if (!r || r.expires_at < Math.floor(Date.now() / 1000)) return null;
    return r;
  }

  /** Claim-once user binding: stamps the request with the first logged-in user to load it.
   * Returns false if it was already bound to a DIFFERENT user (a second login may not
   * read/deny someone else's in-flight request). Idempotent for the same user. */
  bindRequestUser(requestId: string, userId: string): boolean {
    const r = this.getRequest(requestId);
    if (!r) return false;
    if (r.user_id && r.user_id !== userId) return false;
    if (!r.user_id) {
      this.db.query(`UPDATE oauth_requests SET user_id = $u WHERE request_id = $id`).run({ $u: userId, $id: requestId });
    }
    return true;
  }

  /** Single-use consume: the approve/deny handler deletes the request the moment it
   * acts on it, so a back-button replay finds nothing. */
  deleteRequest(requestId: string): void {
    this.db.query(`DELETE FROM oauth_requests WHERE request_id = $id`).run({ $id: requestId });
  }

  // ---- authorization codes ----

  /** Mints the code, returns the RAW value (the only time it exists in plaintext). */
  createCode(c: Omit<OAuthCodeRow, "code_hash" | "used" | "expires_at">, ttlSeconds: number): string {
    const code = randomToken("rmt_code_");
    const now = Math.floor(Date.now() / 1000);
    this.db.query(`DELETE FROM oauth_codes WHERE expires_at < $cutoff`).run({ $cutoff: now - 3600 });
    this.db
      .query(
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, card_id, user_id, resource, scope, used, expires_at)
         VALUES ($hash, $client, $redirect, $challenge, $card, $user, $resource, $scope, 0, $expires)`,
      )
      .run({
        $hash: hashCardSecret(code),
        $client: c.client_id,
        $redirect: c.redirect_uri,
        $challenge: c.code_challenge,
        $card: c.card_id,
        $user: c.user_id,
        $resource: c.resource,
        $scope: c.scope,
        $expires: now + ttlSeconds,
      });
    return code;
  }

  /** Peek the (un-consumed) code row so the caller can validate client_id / redirect_uri
   * / PKCE / resource BEFORE burning it. An honest-but-quirky first attempt that fails a
   * binding check leaves the code redeemable (no forced re-authorize); single-use is still
   * guaranteed by the atomic claimCode() flip the caller makes only after all checks pass. */
  getCodeRow(code: string): OAuthCodeRow | null {
    return this.db
      .query(`SELECT * FROM oauth_codes WHERE code_hash = $h`)
      .get({ $h: hashCardSecret(code) }) as OAuthCodeRow | null;
  }

  /** Atomic single-use claim: flips used 0->1 exactly once. false = the code was already
   * used or expired (a replay or a lost concurrent race) — the caller treats that as a
   * theft signal and revokes the family. */
  claimCode(code: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .query(`UPDATE oauth_codes SET used = 1 WHERE code_hash = $h AND used = 0 AND expires_at >= $now`)
      .run({ $h: hashCardSecret(code), $now: now });
    return r.changes === 1;
  }

  /** OAuth 2.1 code-replay response: revoke every token minted from this code. */
  revokeByCodeHash(codeHash: string): void {
    this.db.query(`UPDATE oauth_tokens SET revoked = 1 WHERE code_hash = $h`).run({ $h: codeHash });
  }

  /** Cascade revoke: when a card is revoked/nuked, every OAuth grant issued for it dies.
   * Defense in depth — the /mcp lane already rejects a revoked card's token at request
   * time, but this keeps the token ledger honest (no live-looking rows for a dead card). */
  revokeTokensByCardId(cardId: string): void {
    this.db.query(`UPDATE oauth_tokens SET revoked = 1 WHERE card_id = $c`).run({ $c: cardId });
  }

  // ---- tokens ----

  /** Mints an access + refresh pair (new family unless rotating). Returns the RAW
   * token values; only hashes are stored. */
  createToken(t: {
    cardId: string;
    userId: string;
    clientId: string;
    resource: string | null;
    scope: string | null;
    accessTtlSeconds: number;
    refreshTtlSeconds: number | null;
    familyId?: string;
    codeHash?: string;
  }): { accessToken: string; refreshToken: string | null; row: OAuthTokenRow } {
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
    const refreshToken = t.refreshTtlSeconds !== null ? randomToken(REFRESH_TOKEN_PREFIX) : null;
    const now = Math.floor(Date.now() / 1000);
    const row: OAuthTokenRow = {
      id: crypto.randomUUID(),
      family_id: t.familyId ?? crypto.randomUUID(),
      access_hash: hashCardSecret(accessToken),
      refresh_hash: refreshToken ? hashCardSecret(refreshToken) : null,
      card_id: t.cardId,
      user_id: t.userId,
      client_id: t.clientId,
      resource: t.resource,
      scope: t.scope,
      code_hash: t.codeHash ?? null,
      access_expires_at: now + t.accessTtlSeconds,
      refresh_expires_at: t.refreshTtlSeconds !== null ? now + t.refreshTtlSeconds : null,
      revoked: 0,
      created_at: now,
    };
    // opportunistic GC: only reap rows whose refresh window has fully ELAPSED (plus a
    // 1-day grace). A revoked-but-not-yet-expired row is kept on purpose: it is the
    // reuse-detection witness for a rotated-out refresh token (OAuth 2.1 breach
    // response), so deleting it before its TTL would silently drop the family-kill
    // signal for replays in the 7-to-30-day window. Indexed by created_at.
    this.db
      .query(
        `DELETE FROM oauth_tokens
         WHERE COALESCE(refresh_expires_at, access_expires_at) < $cutoff`,
      )
      .run({ $cutoff: now - 86_400 });
    this.db
      .query(
        `INSERT INTO oauth_tokens (id, family_id, access_hash, refresh_hash, card_id, user_id, client_id,
                                   resource, scope, code_hash, access_expires_at, refresh_expires_at, revoked, created_at)
         VALUES ($id, $family, $access, $refresh, $card, $user, $client, $resource, $scope, $code, $aexp, $rexp, 0, $created)`,
      )
      .run({
        $id: row.id,
        $family: row.family_id,
        $access: row.access_hash,
        $refresh: row.refresh_hash,
        $card: row.card_id,
        $user: row.user_id,
        $client: row.client_id,
        $resource: row.resource,
        $scope: row.scope,
        $code: row.code_hash,
        $aexp: row.access_expires_at,
        $rexp: row.refresh_expires_at,
        $created: row.created_at,
      });
    return { accessToken, refreshToken, row };
  }

  /** Live access-token lookup for the /mcp bearer lane: unexpired + unrevoked. */
  getByAccessToken(accessToken: string): OAuthTokenRow | null {
    const r = this.db
      .query(`SELECT * FROM oauth_tokens WHERE access_hash = $h`)
      .get({ $h: hashCardSecret(accessToken) }) as OAuthTokenRow | null;
    if (!r || r.revoked || r.access_expires_at < Math.floor(Date.now() / 1000)) return null;
    return r;
  }

  /** Refresh lookup WITHOUT liveness filtering — the caller distinguishes "live"
   * (rotate) from "revoked" (reuse -> kill the family) from "expired" (plain reject). */
  getByRefreshToken(refreshToken: string): OAuthTokenRow | null {
    return this.db
      .query(`SELECT * FROM oauth_tokens WHERE refresh_hash = $h`)
      .get({ $h: hashCardSecret(refreshToken) }) as OAuthTokenRow | null;
  }

  /** RFC 7009 lookup: match a presented token against either hash, liveness ignored. */
  findByAnyToken(token: string): OAuthTokenRow | null {
    const h = hashCardSecret(token);
    return this.db
      .query(`SELECT * FROM oauth_tokens WHERE access_hash = $h OR refresh_hash = $h`)
      .get({ $h: h }) as OAuthTokenRow | null;
  }

  /** Atomic rotation claim: revokes the presented row exactly once. False = it was
   * already revoked (a rotated-refresh REPLAY) and the caller must kill the family. */
  claimForRotation(rowId: string): boolean {
    const r = this.db
      .query(`UPDATE oauth_tokens SET revoked = 1 WHERE id = $id AND revoked = 0`)
      .run({ $id: rowId });
    return r.changes === 1;
  }

  revokeFamily(familyId: string): void {
    this.db.query(`UPDATE oauth_tokens SET revoked = 1 WHERE family_id = $f`).run({ $f: familyId });
  }

  revokeById(rowId: string): void {
    this.db.query(`UPDATE oauth_tokens SET revoked = 1 WHERE id = $id`).run({ $id: rowId });
  }
}
