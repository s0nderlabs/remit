// OAuth 2.1 authorization-server lane for the MCP endpoint (fork B, locked Jun 7 2026
// research call): remit self-hosts the BOUNDED AS profile — public clients only, PKCE
// S256 only, auth-code + rotating refresh, DCR (RFC 7591), no CIMD day-1 — because the
// heavyweight parts of a real AS (login, identity) are delegated to the already-shipped
// Privy dashboard session, and tokens are opaque card-scoped rows in sqlite.
//
// Discovery shape (mirrors Linear/Sentry, verified live 2026-06-07):
//   - RFC 9728 PRM at /.well-known/oauth-protected-resource/mcp (+ root fallback)
//   - RFC 8414 AS metadata at /.well-known/oauth-authorization-server
//   - bare-/mcp 401s carry WWW-Authenticate: Bearer resource_metadata="..." (mcp/routes)
// Flow: /authorize validates + persists the request, 302s to the dashboard consent page
// (Privy login + card picker); the approve API mints the code; /token redeems it with
// PKCE and mints opaque rmt_at_/rmt_rt_ tokens. RFC 8707 `resource` is round-tripped
// end-to-end (dropping it is the documented ChatGPT stuck-flow cause).

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import type { AppDeps } from "../deps";
import { envInt } from "../deps";
import { RateLimiter, clientIp } from "../ratelimit";
import type { OAuthStore } from "./store";

// ---------------------------------------------------------------------------
// Canonical URLs
// ---------------------------------------------------------------------------

/** The public origin (issuer). Mirrors cardUrl()'s base resolution. */
export function publicBase(): string {
  const raw = process.env.REMIT_PUBLIC_MCP_BASE ?? `http://localhost:${process.env.PORT ?? 4070}`;
  return raw.replace(/\/+$/, "");
}

/** RFC 8707 canonical resource URI for the MCP endpoint (no trailing slash). */
export const canonicalResource = (): string => `${publicBase()}/mcp`;

export const resourceMetadataUrl = (): string =>
  `${publicBase()}/.well-known/oauth-protected-resource/mcp`;

/** Dashboard origin hosting the consent (card-picker) page. */
const dashboardBase = (): string =>
  (process.env.REMIT_DASHBOARD_BASE ?? "http://localhost:4071").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Redirect-URI registration policy:
 *  - https: any host (optionally restricted via REMIT_OAUTH_REDIRECT_HOSTS),
 *  - http: loopback only, any port (RFC 8252 — Claude Code, VS Code, Cursor local),
 *  - custom schemes (cursor:// ...): allowed — rejecting them breaks Cursor,
 *  - no fragments anywhere. Exact-string match happens later at /authorize. */
function redirectUriAllowed(uri: string): boolean {
  if (uri.length > 2000 || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`);
  if (url.protocol === "https:") {
    const restrict = (process.env.REMIT_OAUTH_REDIRECT_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return restrict.length === 0 || restrict.includes(url.hostname);
  }
  return true; // custom scheme (cursor://, vscode:// ...)
}

const b64urlSha256 = (input: string): string => createHash("sha256").update(input).digest("base64url");

/** Append query params to a redirect_uri by exact string concatenation (NOT `new URL()`),
 * preserving custom-scheme URIs byte-for-byte (`cursor://`, `vscode://`). The single
 * builder for BOTH the /authorize error path and the consent approve/deny redirects, so
 * they can never diverge on encoding. */
export const appendRedirectParams = (uri: string, params: Record<string, string>): string => {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? uri + (uri.includes("?") ? "&" : "?") + qs : uri;
};

/** RFC 8707 resources the RS will honor: the canonical one, plus any legacy values kept
 * during a base-URL migration so already-minted tokens don't all hard-401 at once. */
export const acceptedResources = (): string[] => {
  const extra = (process.env.REMIT_OAUTH_ACCEPTED_RESOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [canonicalResource(), ...extra];
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function oauthRoutes(deps: AppDeps, oauth: OAuthStore): Hono {
  const app = new Hono();

  const REQUEST_TTL_S = 600; // consent window (Privy login can take a minute)
  const CODE_TTL_S = 120; // redirect -> token exchange is automated
  const accessTtl = () => envInt("REMIT_OAUTH_ACCESS_TTL", 3600);
  const refreshTtl = () => envInt("REMIT_OAUTH_REFRESH_TTL", 30 * 86_400);

  const registerLimit = new RateLimiter(envInt("REMIT_OAUTH_REGISTER_LIMIT", 10), 60_000);
  const authorizeLimit = new RateLimiter(envInt("REMIT_OAUTH_AUTHORIZE_LIMIT", 30), 60_000);
  const tokenLimit = new RateLimiter(envInt("REMIT_OAUTH_TOKEN_LIMIT", 60), 60_000);

  // discovery + token endpoints are public cross-origin by design (browser-based MCP
  // clients, inspector tooling); security is PKCE + token possession, never origin
  app.use("/.well-known/*", cors());
  app.use("/register", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
  app.use("/token", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
  app.use("/revoke", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
  // hard body cap on every credential-bearing POST, BEFORE any parse. Unlike a
  // Content-Length check this also bounds chunked/streamed bodies with no length header.
  const cap = (max: number) =>
    bodyLimit({ maxSize: max, onError: (c) => c.json({ error: "invalid_request", error_description: "request body too large" }, 413) });
  app.use("/register", cap(64 * 1024));
  app.use("/token", cap(16 * 1024));
  app.use("/revoke", cap(16 * 1024));

  // ---- RFC 9728 protected-resource metadata (path-aware FIRST, root fallback) ----
  const prm = (c: Context) =>
    c.json({
      resource: canonicalResource(),
      authorization_servers: [publicBase()],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-protected-resource", prm);

  // ---- RFC 8414 authorization-server metadata ----
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const base = publicBase();
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      scopes_supported: ["mcp"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"], // S256 only — `plain` is a downgrade surface
      client_id_metadata_document_supported: false, // DCR-led day-1 (CIMD buggy/missing in CC + VS Code)
      resource: canonicalResource(),
      resource_metadata: resourceMetadataUrl(),
    });
  });

  // ---- RFC 7591 dynamic client registration (open, rate-limited) ----
  app.post("/register", async (c) => {
    if (!registerLimit.allow(clientIp(c), Date.now())) {
      return c.json({ error: "invalid_client_metadata", error_description: "too many registrations" }, 429);
    }
    // body size is bounded by the cap() bodyLimit middleware above (handles chunked bodies too)
    let body: {
      redirect_uris?: unknown;
      client_name?: unknown;
      grant_types?: unknown;
      response_types?: unknown;
      token_endpoint_auth_method?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-10 strings" }, 400);
    }
    for (const u of uris as string[]) {
      if (!redirectUriAllowed(u)) {
        return c.json({ error: "invalid_redirect_uri", error_description: `redirect uri not allowed: ${u}` }, 400);
      }
    }
    // public clients only: a confidential registration is answered with `none` anyway
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;
    const client = oauth.createClient({ redirectUris: uris as string[], clientName });
    return c.json(
      {
        client_id: client.client_id,
        client_id_issued_at: client.created_at,
        redirect_uris: client.redirect_uris,
        client_name: client.client_name ?? undefined,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  // ---- authorization endpoint: validate -> persist request -> consent page ----
  app.get("/authorize", (c) => {
    if (!authorizeLimit.allow(clientIp(c), Date.now())) return c.text("too many requests", 429);
    const q = (k: string) => c.req.query(k) ?? undefined;

    // client_id + redirect_uri validate FIRST; on failure NEVER redirect (open-redirect guard)
    const client = q("client_id") ? oauth.getClient(q("client_id")!) : null;
    if (!client) return c.text("unknown client_id", 400);
    const redirectUri = q("redirect_uri");
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return c.text("redirect_uri is not registered for this client", 400);
    }

    // everything else reports back to the client via the (validated) redirect. Use the
    // exact-string appender (not new URL()) so custom-scheme redirects survive the error path.
    const fail = (error: string, description: string) =>
      c.redirect(
        appendRedirectParams(redirectUri, {
          error,
          error_description: description,
          ...(q("state") ? { state: q("state")! } : {}),
        }),
        302,
      );

    if (q("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code");
    if (q("response_mode") && q("response_mode") !== "query") {
      return fail("invalid_request", "only response_mode=query");
    }
    const challenge = q("code_challenge");
    if (!challenge || challenge.length > 256) return fail("invalid_request", "code_challenge required (PKCE)");
    if (q("code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256");
    }
    const state = q("state");
    if (state && state.length > 2000) return fail("invalid_request", "state too long");
    const scope = q("scope");
    if (scope && scope.length > 500) return fail("invalid_scope", "scope too long");
    const resource = q("resource");
    if (resource && resource !== canonicalResource()) {
      return fail("invalid_target", `resource must be ${canonicalResource()}`);
    }

    // store what the client actually SENT (null when omitted) so the /token round-trip
    // check stays symmetric; the canonical default is applied at token-MINT time instead,
    // so every minted token still ends up audience-pinned (RFC 8707 enforced, not opt-in).
    const requestId = oauth.createRequest(
      {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        resource: resource ?? null,
        scope: scope ?? null,
        state: state ?? null,
      },
      REQUEST_TTL_S,
    );
    return c.redirect(`${dashboardBase()}/connect?request=${requestId}`, 302);
  });

  // ---- token endpoint (public clients; form-encoded in, strict RFC 6749 JSON out) ----
  app.post("/token", async (c) => {
    if (!tokenLimit.allow(clientIp(c), Date.now())) {
      return c.json({ error: "invalid_request", error_description: "too many requests" }, 429);
    }
    let form: Record<string, string>;
    const ctype = c.req.header("content-type") ?? "";
    try {
      if (ctype.includes("application/json")) {
        form = (await c.req.json()) as Record<string, string>;
      } else {
        form = Object.fromEntries(
          Object.entries(await c.req.parseBody()).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>;
      }
    } catch {
      return c.json({ error: "invalid_request", error_description: "unreadable body" }, 400);
    }

    const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
    const tokenError = (error: string, description: string, status: 400 | 401 = 400) =>
      c.json({ error, error_description: description }, status, noStore);
    const tokenResponse = (minted: { accessToken: string; refreshToken: string | null }, scope: string | null) =>
      c.json(
        {
          access_token: minted.accessToken,
          token_type: "bearer",
          expires_in: accessTtl(),
          ...(minted.refreshToken ? { refresh_token: minted.refreshToken } : {}),
          ...(scope ? { scope } : {}),
        },
        200,
        noStore,
      );

    if (form.grant_type === "authorization_code") {
      const { code, code_verifier, redirect_uri, client_id, resource } = form;
      if (!code || !code_verifier || !client_id) {
        return tokenError("invalid_request", "code, code_verifier and client_id are required");
      }
      if (!oauth.getClient(client_id)) return tokenError("invalid_client", "unknown client", 401);
      if (code_verifier.length < 43 || code_verifier.length > 128) {
        return tokenError("invalid_grant", "code_verifier length out of range (RFC 7636)");
      }
      const nowSec = Math.floor(Date.now() / 1000);
      // PEEK the un-consumed code: validate bindings BEFORE burning it, so an honest
      // client whose first attempt trips a binding check can retry (no forced re-auth).
      // Single-use is still atomic via claimCode() once every check passes.
      const row = oauth.getCodeRow(code);
      if (!row || row.expires_at < nowSec) {
        return tokenError("invalid_grant", "code is invalid or expired");
      }
      if (row.used) {
        // a redeemed code presented again is a theft signal: kill what it minted
        oauth.revokeByCodeHash(row.code_hash);
        return tokenError("invalid_grant", "code has already been used");
      }
      if (row.client_id !== client_id) return tokenError("invalid_grant", "code was issued to a different client");
      if (row.redirect_uri !== (redirect_uri ?? "")) {
        return tokenError("invalid_grant", "redirect_uri does not match the authorization request");
      }
      if (b64urlSha256(code_verifier) !== row.code_challenge) {
        return tokenError("invalid_grant", "PKCE verification failed");
      }
      // RFC 8707 round-trip: if the client scoped the grant, the exchange must match
      if (row.resource && resource !== row.resource) {
        return tokenError("invalid_target", `resource must be ${row.resource}`);
      }
      if (resource && resource !== canonicalResource()) {
        return tokenError("invalid_target", `resource must be ${canonicalResource()}`);
      }
      // card liveness, mirroring the refresh grant: a card revoked/nuked/expired during the
      // ~120s code TTL must not mint a fresh-looking credential.
      const card = deps.store.getCard(row.card_id);
      if (!card || card.status === "revoked" || card.status === "nuked") {
        return tokenError("invalid_grant", "the granted card is no longer live");
      }
      if (card.terms.expiry !== undefined && nowSec >= card.terms.expiry) {
        return tokenError("invalid_grant", "the granted card has expired");
      }
      // all checks passed: atomically claim the code (single-use). A lost claim here is a
      // concurrent double-submit; reject without killing the winner's just-minted token.
      if (!oauth.claimCode(code)) return tokenError("invalid_grant", "code has already been used");
      const minted = oauth.createToken({
        cardId: row.card_id,
        userId: row.user_id,
        clientId: client_id,
        // audience-pin EVERY minted token: clients that omitted `resource` get the
        // canonical default, so RFC 8707 binding is enforced rather than opt-in
        resource: row.resource ?? canonicalResource(),
        scope: row.scope,
        accessTtlSeconds: accessTtl(),
        refreshTtlSeconds: refreshTtl(),
        codeHash: row.code_hash,
      });
      return tokenResponse(minted, row.scope);
    }

    if (form.grant_type === "refresh_token") {
      const { refresh_token, client_id } = form;
      if (!refresh_token || !client_id) {
        return tokenError("invalid_request", "refresh_token and client_id are required");
      }
      const row = oauth.getByRefreshToken(refresh_token);
      if (!row || row.client_id !== client_id) return tokenError("invalid_grant", "unknown refresh token");
      if (row.revoked) {
        // a rotated-out refresh token coming back = replay; the whole family dies
        oauth.revokeFamily(row.family_id);
        return tokenError("invalid_grant", "refresh token has been rotated or revoked");
      }
      if ((row.refresh_expires_at ?? 0) < Math.floor(Date.now() / 1000)) {
        return tokenError("invalid_grant", "refresh token expired");
      }
      const card = deps.store.getCard(row.card_id);
      if (!card || card.status === "revoked" || card.status === "nuked") {
        oauth.revokeFamily(row.family_id);
        return tokenError("invalid_grant", "the granted card is no longer live");
      }
      if (!oauth.claimForRotation(row.id)) {
        oauth.revokeFamily(row.family_id);
        return tokenError("invalid_grant", "refresh token has been rotated or revoked");
      }
      const minted = oauth.createToken({
        cardId: row.card_id,
        userId: row.user_id,
        clientId: row.client_id,
        resource: row.resource ?? canonicalResource(), // pin legacy unpinned rows on rotation
        scope: row.scope,
        accessTtlSeconds: accessTtl(),
        refreshTtlSeconds: refreshTtl(),
        familyId: row.family_id,
        codeHash: row.code_hash ?? undefined,
      });
      return tokenResponse(minted, row.scope);
    }

    return tokenError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  // ---- RFC 7009 revocation: always 200, even for unknown tokens ----
  app.post("/revoke", async (c) => {
    if (!tokenLimit.allow(clientIp(c), Date.now())) {
      return c.json({ error: "invalid_request", error_description: "too many requests" }, 429);
    }
    let token: string | undefined;
    try {
      const ctype = c.req.header("content-type") ?? "";
      if (ctype.includes("application/json")) {
        token = ((await c.req.json()) as { token?: string }).token;
      } else {
        const body = await c.req.parseBody();
        token = typeof body.token === "string" ? body.token : undefined;
      }
    } catch {
      // fall through: unreadable body is answered like an unknown token
    }
    if (token) {
      const row = oauth.findByAnyToken(token);
      if (row) oauth.revokeFamily(row.family_id); // revoking either half kills the grant
    }
    return c.body(null, 200);
  });

  return app;
}
