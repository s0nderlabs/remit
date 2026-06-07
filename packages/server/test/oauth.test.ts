// OAuth 2.1 lane tests: the full authorization-code + PKCE + consent + refresh +
// revocation matrix against the REAL Hono app, ending with a REAL MCP client (SDK)
// speaking Streamable HTTP authenticated by the minted access token. Only the relayer
// + chain reads are faked. The static-secret lanes are asserted UNAFFECTED.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
  KeyedMutex,
  Store,
  issueRootCard,
  type CardTerms,
  type EstimateResult,
  type Relayer,
  type RelayerTransaction,
} from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { OAuthStore } from "../src/oauth/store";

const user = privateKeyToAccount(generatePrivateKey());
const userId = user.address.toLowerCase();

class FakeRelayer {
  async getFeeData() {
    return { minFee: "0.01", rate: 1598, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address, targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a" as Address, context: "ctx" };
  }
  async estimate(_tx: RelayerTransaction[]): Promise<EstimateResult> {
    return { success: true, requiredPaymentAmount: "10000", context: "ctx-ok", error: null, raw: null };
  }
  async send(_tx: RelayerTransaction[]): Promise<string> {
    return "0xreq";
  }
  async getStatus() {
    return { status: 200, txHash: "0xfaketx" as `0x${string}`, raw: null };
  }
  async waitForStatus() {
    return { status: 200, txHash: "0xfaketx" as `0x${string}`, raw: null, timedOut: false };
  }
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let oauthDb: OAuthStore; // second handle on the SAME sqlite db, for direct row surgery

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "f".repeat(64);
  store = new Store(":memory:");
  const deps: AppDeps = {
    spendMutex: new KeyedMutex(),
    store,
    relayer: new FakeRelayer() as unknown as Relayer,
    userSigner: user,
    adminToken: "test-admin",
    // fake Privy verifier: "pt-<name>" is a valid session for did:privy:<name>
    verifyPrivyToken: async (token) => (token.startsWith("pt-") ? { did: `did:privy:${token.slice(3)}` } : null),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
  };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.REMIT_PUBLIC_MCP_BASE = base;
  oauthDb = new OAuthStore(store.db);
  // alice: the Privy-bound card owner; bob: a different login with no cards
  store.upsertUser({ id: userId, address: user.address, privyDid: "did:privy:alice" });
  const bob = privateKeyToAccount(generatePrivateKey());
  store.upsertUser({ id: bob.address.toLowerCase(), address: bob.address, privyDid: "did:privy:bob" });
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function issue(terms: CardTerms, name = "oauth-test"): Promise<{ cardId: string; secret: string }> {
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId, name, terms },
  );
  return { cardId: issued.cardId, secret: issued.secret };
}

let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

function pkce(): { verifier: string; challenge: string } {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(redirectUris: string[], name = "test client", ip = freshIp()) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name }),
  });
}

async function authorize(params: Record<string, string>, ip = freshIp()): Promise<Response> {
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetch(u, { redirect: "manual", headers: { "x-forwarded-for": ip } });
}

/** authorize -> request id parsed from the consent-page redirect */
async function authorizeRequestId(params: Record<string, string>): Promise<string> {
  const res = await authorize(params);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.pathname).toBe("/connect");
  return loc.searchParams.get("request")!;
}

async function approve(requestId: string, cardId: string, bearer = "pt-alice"): Promise<Response> {
  return fetch(`${base}/api/oauth/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, card_id: cardId }),
  });
}

async function exchange(form: Record<string, string>, ip = freshIp()): Promise<Response> {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams(form).toString(),
  });
}

/** the whole happy path up to a token response body */
async function mintTokens(opts?: { scope?: string; resource?: string; cardTerms?: CardTerms }) {
  const { cardId } = await issue(opts?.cardTerms ?? { pay: { period: { amount: "25", seconds: 604800 } } });
  const reg = await register(["http://127.0.0.1:7777/callback"]);
  const { client_id } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const params: Record<string, string> = {
    response_type: "code",
    client_id,
    redirect_uri: "http://127.0.0.1:7777/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
  };
  if (opts?.scope) params.scope = opts.scope;
  if (opts?.resource) params.resource = opts.resource;
  const requestId = await authorizeRequestId(params);
  const ap = await approve(requestId, cardId);
  expect(ap.status).toBe(200);
  const { redirect_to } = (await ap.json()) as { redirect_to: string };
  const cb = new URL(redirect_to);
  const code = cb.searchParams.get("code")!;
  const tokenForm: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: "http://127.0.0.1:7777/callback",
    client_id,
  };
  if (opts?.resource) tokenForm.resource = opts.resource;
  const res = await exchange(tokenForm);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  };
  return { cardId, client_id, code, verifier, body, redirect: cb };
}

async function connectMcp(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "oauth-test-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

describe("discovery metadata", () => {
  test("PRM served path-aware AND at root, pointing at the canonical resource", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const prm = (await res.json()) as Record<string, unknown>;
      expect(prm.resource).toBe(`${base}/mcp`);
      expect(prm.authorization_servers).toEqual([base]);
      expect(prm.bearer_methods_supported).toEqual(["header"]);
    }
  });

  test("AS metadata: S256-only, public clients, DCR-led", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.issuer).toBe(base);
    expect(m.authorization_endpoint).toBe(`${base}/authorize`);
    expect(m.token_endpoint).toBe(`${base}/token`);
    expect(m.registration_endpoint).toBe(`${base}/register`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(m.client_id_metadata_document_supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DCR
// ---------------------------------------------------------------------------

describe("dynamic client registration", () => {
  test("registers https, loopback-http and custom-scheme redirect URIs", async () => {
    const res = await register([
      "https://chatgpt.com/connector/oauth/abc123",
      "http://localhost:33418/",
      "http://127.0.0.1:41999/callback",
      "cursor://anysphere.cursor-mcp/oauth/callback",
    ]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^rmt_client_/);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  test("rejects non-loopback http, fragments, and empty lists", async () => {
    expect((await register(["http://evil.example.com/callback"])).status).toBe(400);
    expect((await register(["https://ok.example.com/cb#frag"])).status).toBe(400);
    expect((await register([])).status).toBe(400);
  });

  test("per-IP rate limit trips", async () => {
    const ip = "9.9.9.9";
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await register(["http://localhost:1/cb"], "limit probe", ip)).status;
    }
    expect(last).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// authorize validation
// ---------------------------------------------------------------------------

describe("authorize endpoint", () => {
  test("unknown client / unregistered redirect_uri get a 400 page, never a redirect", async () => {
    const r1 = await authorize({ response_type: "code", client_id: "rmt_client_nope", redirect_uri: "http://localhost:1/cb" });
    expect(r1.status).toBe(400);
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const r2 = await authorize({ response_type: "code", client_id, redirect_uri: "http://localhost:2/other" });
    expect(r2.status).toBe(400);
  });

  test("param errors redirect back with error codes; resource must be canonical", async () => {
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const common = { response_type: "code", client_id, redirect_uri: "http://localhost:1/cb", state: "s1" };

    const noPkce = await authorize(common);
    expect(noPkce.status).toBe(302);
    const u1 = new URL(noPkce.headers.get("location")!);
    expect(u1.searchParams.get("error")).toBe("invalid_request");
    expect(u1.searchParams.get("state")).toBe("s1");

    const { challenge } = pkce();
    const plain = await authorize({ ...common, code_challenge: challenge, code_challenge_method: "plain" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    const badResource = await authorize({
      ...common,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://somewhere-else.example/mcp",
    });
    expect(new URL(badResource.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

// ---------------------------------------------------------------------------
// the full flow + MCP client
// ---------------------------------------------------------------------------

describe("authorization-code flow end to end", () => {
  test("happy path: consent mints a card-scoped token a REAL MCP client can spend with", async () => {
    const { body, redirect } = await mintTokens({ scope: "mcp", resource: `${base}/mcp` });
    expect(redirect.searchParams.get("state")).toBe("st-123");
    expect(body.access_token).toMatch(/^rmt_at_/);
    expect(body.refresh_token).toMatch(/^rmt_rt_/);
    expect(body.token_type).toBe("bearer");
    expect(body.scope).toBe("mcp");
    expect(body.expires_in).toBeGreaterThan(0);

    const client = await connectMcp({ authorization: `Bearer ${body.access_token}` });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("pay");
    const result = await client.callTool({
      name: "pay",
      arguments: { to: "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127", amount: "1.50", memo: "oauth lane" },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.status).toBe("confirmed");
    await client.close();
  });

  test("scope is echoed verbatim (ChatGPT exact-match + CC offline_access tolerance)", async () => {
    const { body } = await mintTokens({ scope: "mcp offline_access" });
    expect(body.scope).toBe("mcp offline_access");
  });

  test("resource omitted entirely still works (resource is optional client-side)", async () => {
    const { body } = await mintTokens();
    expect(body.access_token).toMatch(/^rmt_at_/);
    const client = await connectMcp({ authorization: `Bearer ${body.access_token}` });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  test("PKCE mismatch is refused", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const { redirect_to } = (await (await approve(requestId, cardId)).json()) as { redirect_to: string };
    const code = new URL(redirect_to).searchParams.get("code")!;
    const bad = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url"),
      redirect_uri: "http://localhost:1/cb",
      client_id,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("code replay is refused AND revokes the tokens it minted", async () => {
    const { body, code, verifier, client_id } = await mintTokens();
    // token works before the replay
    const ok = await connectMcp({ authorization: `Bearer ${body.access_token}` });
    await ok.close();
    const replay = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:7777/callback",
      client_id,
    });
    expect(replay.status).toBe(400);
    // the previously minted token is now dead
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  test("a binding mismatch does NOT burn the code: the honest retry succeeds", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const { redirect_to } = (await (await approve(requestId, cardId)).json()) as { redirect_to: string };
    const code = new URL(redirect_to).searchParams.get("code")!;
    // first attempt: client forgets redirect_uri -> invalid_grant, but code survives
    const quirky = await exchange({ grant_type: "authorization_code", code, code_verifier: verifier, client_id });
    expect(quirky.status).toBe(400);
    // corrected retry redeems fine (single-use still enforced by the atomic claim)
    const retry = await exchange({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: "http://localhost:1/cb", client_id,
    });
    expect(retry.status).toBe(200);
  });

  test("a card revoked between consent and exchange cannot mint tokens", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const { redirect_to } = (await (await approve(requestId, cardId)).json()) as { redirect_to: string };
    const code = new URL(redirect_to).searchParams.get("code")!;
    store.setSubtreeStatus(cardId, "revoked"); // dies during the ~120s code TTL
    const res = await exchange({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: "http://localhost:1/cb", client_id,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("code is bound to client_id and redirect_uri", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb", "http://localhost:1/cb2"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const other = await register(["http://localhost:1/cb"]);
    const { client_id: otherClient } = (await other.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const { redirect_to } = (await (await approve(requestId, cardId)).json()) as { redirect_to: string };
    const code = new URL(redirect_to).searchParams.get("code")!;

    const wrongClient = await exchange({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: "http://localhost:1/cb", client_id: otherClient,
    });
    expect(wrongClient.status).toBe(400);
    const wrongRedirect = await exchange({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: "http://localhost:1/cb2", client_id,
    });
    expect(wrongRedirect.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// refresh + revocation
// ---------------------------------------------------------------------------

describe("refresh rotation + revocation", () => {
  test("rotation: new pair works, old pair dies, replayed refresh kills the family", async () => {
    const { body, client_id } = await mintTokens();
    const r1 = await exchange({ grant_type: "refresh_token", refresh_token: body.refresh_token!, client_id });
    expect(r1.status).toBe(200);
    const fresh = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(fresh.access_token).toMatch(/^rmt_at_/);

    // old access died with the rotation; new one works
    const oldRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(oldRes.status).toBe(401);
    const client = await connectMcp({ authorization: `Bearer ${fresh.access_token}` });
    await client.close();

    // replaying the ROTATED-OUT refresh token kills the whole family
    const replay = await exchange({ grant_type: "refresh_token", refresh_token: body.refresh_token!, client_id });
    expect(replay.status).toBe(400);
    const afterKill = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${fresh.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(afterKill.status).toBe(401);
  });

  test("RFC 7009 revoke: kills the grant, answers 200 even for unknown tokens", async () => {
    const { body } = await mintTokens();
    const res = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": freshIp() },
      body: new URLSearchParams({ token: body.access_token }).toString(),
    });
    expect(res.status).toBe(200);
    const dead = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(dead.status).toBe(401);
    const unknown = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": freshIp() },
      body: new URLSearchParams({ token: "rmt_at_does-not-exist" }).toString(),
    });
    expect(unknown.status).toBe(200);
  });

  test("card revoke cascades: the OAuth token dies with the card", async () => {
    const { body, cardId } = await mintTokens();
    store.setSubtreeStatus(cardId, "revoked");
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("card revoked");
  });

  test("refresh against a revoked card is refused", async () => {
    const { body, cardId, client_id } = await mintTokens();
    store.setSubtreeStatus(cardId, "revoked");
    const r = await exchange({ grant_type: "refresh_token", refresh_token: body.refresh_token!, client_id });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// consent scoping + expiry
// ---------------------------------------------------------------------------

describe("consent scoping", () => {
  test("a different login cannot grant someone else's card", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await approve(requestId, cardId, "pt-bob");
    expect(res.status).toBe(422); // foreign cards look nonexistent
  });

  test("a request touched by one login is invisible to another (claim-once binding)", async () => {
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // alice loads the consent page (claims the request)
    const aliceRead = await fetch(`${base}/api/oauth/request?id=${requestId}`, {
      headers: { authorization: "Bearer pt-alice" },
    });
    expect(aliceRead.status).toBe(200);
    // bob can neither read nor deny it
    const bobRead = await fetch(`${base}/api/oauth/request?id=${requestId}`, {
      headers: { authorization: "Bearer pt-bob" },
    });
    expect(bobRead.status).toBe(422);
    const bobDeny = await fetch(`${base}/api/oauth/deny`, {
      method: "POST",
      headers: { authorization: "Bearer pt-bob", "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    });
    expect(bobDeny.status).toBe(422);
    // alice can still act on it
    const aliceDeny = await fetch(`${base}/api/oauth/deny`, {
      method: "POST",
      headers: { authorization: "Bearer pt-alice", "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    });
    expect(aliceDeny.status).toBe(200);
    expect(((await aliceDeny.json()) as { redirect_to: string }).redirect_to).toContain("error=access_denied");
  });

  test("approve is single-use: a back-button replay finds nothing", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect((await approve(requestId, cardId)).status).toBe(200);
    expect((await approve(requestId, cardId)).status).toBe(422);
  });

  test("expired authorization requests are refused at approve", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // direct row surgery: force the request into the past
    store.db.query(`UPDATE oauth_requests SET expires_at = 1 WHERE request_id = $id`).run({ $id: requestId });
    expect((await approve(requestId, cardId)).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// /mcp lane behavior (the ONE change to the existing surface)
// ---------------------------------------------------------------------------

describe("/mcp lane coexistence", () => {
  test("bare /mcp 401 now advertises OAuth discovery; the secret path does NOT", async () => {
    const bare = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(bare.status).toBe(401);
    const challenge = bare.headers.get("www-authenticate");
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);

    const pathLane = await fetch(`${base}/c/bogus-secret/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(pathLane.status).toBe(401);
    expect(pathLane.headers.get("www-authenticate")).toBeNull();
  });

  test("expired access tokens 401 with the discovery header (clients re-auth/refresh)", async () => {
    const { body } = await mintTokens();
    store.db
      .query(`UPDATE oauth_tokens SET access_expires_at = 1 WHERE access_hash = $h`)
      .run({ $h: createHash("sha256").update(body.access_token).digest("hex") });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  test("static-secret lanes still work byte-for-byte (a real client on both lanes)", async () => {
    const { secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } });
    const viaPath = new Client({ name: "t", version: "0" });
    await viaPath.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${secret}/mcp`)));
    expect((await viaPath.listTools()).tools.length).toBeGreaterThan(0);
    await viaPath.close();
    const viaBearer = await connectMcp({ authorization: `Bearer ${secret}` });
    expect((await viaBearer.listTools()).tools.length).toBeGreaterThan(0);
    await viaBearer.close();
  });

  test("an OAuth access token is NOT honored on the URL-path lane (tokens never ride URLs)", async () => {
    const { body } = await mintTokens();
    const res = await fetch(`${base}/c/${body.access_token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  test("token endpoint also accepts JSON bodies (defensive client compat)", async () => {
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const reg = await register(["http://localhost:1/cb"]);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const { redirect_to } = (await (await approve(requestId, cardId)).json()) as { redirect_to: string };
    const code = new URL(redirect_to).searchParams.get("code")!;
    const res = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "http://localhost:1/cb",
        client_id,
      }),
    });
    expect(res.status).toBe(200);
  });
});
