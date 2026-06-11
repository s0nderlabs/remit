// Harness-conformance suite (Jun 11 2026): pins remit's MCP surface against the verified
// protocol fingerprints of every real client harness (report-mcp-harness-verify-2026-06-11
// in project memory), so "works in <harness>" regressions surface here instead of in the
// field. Three layers:
//   1. DCR redirect-URI matrix — each harness's EXACT registration shape must keep passing
//   2. full PKCE flows per redirect family (loopback / custom-scheme / https)
//   3. transport fingerprints + edge battery on both auth lanes
// Sibling of oauth.test.ts (which owns the deep token-lifecycle matrix); this file is
// per-harness shapes, not exhaustive grant logic.

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

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "f".repeat(64);
  store = new Store(":memory:");
  const deps: AppDeps = {
    spendMutex: new KeyedMutex(),
    store,
    relayer: new FakeRelayer() as unknown as Relayer,
    userSigner: user,
    adminToken: "test-admin",
    verifyPrivyToken: async (token) => (token.startsWith("pt-") ? { did: `did:privy:${token.slice(3)}` } : null),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
  };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.REMIT_PUBLIC_MCP_BASE = base;
  store.upsertUser({ id: userId, address: user.address, privyDid: "did:privy:alice" });
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// helpers (mirroring oauth.test.ts so the two suites read the same)
// ---------------------------------------------------------------------------

async function issue(terms: CardTerms, name = "conformance"): Promise<{ cardId: string; secret: string }> {
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId, name, terms },
  );
  return { cardId: issued.cardId, secret: issued.secret };
}

let ipCounter = 0;
const freshIp = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

function pkce(): { verifier: string; challenge: string } {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(redirectUris: string[], name: string, ip = freshIp()) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name }),
  });
}

async function authorizeRequestId(params: Record<string, string>): Promise<string> {
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: "manual", headers: { "x-forwarded-for": freshIp() } });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.pathname).toBe("/connect");
  return loc.searchParams.get("request")!;
}

async function approve(requestId: string, cardId: string): Promise<string> {
  const res = await fetch(`${base}/api/oauth/approve`, {
    method: "POST",
    headers: { authorization: "Bearer pt-alice", "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, card_id: cardId }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { redirect_to: string }).redirect_to;
}

async function exchange(form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": freshIp() },
    body: new URLSearchParams(form).toString(),
  });
}

/** Full authorization-code + PKCE flow for one harness shape; returns the token body. */
async function fullFlow(opts: {
  clientName: string;
  redirectUris: string[];
  useRedirect?: string; // which registered URI to authorize with (default: first)
  resource?: string;
  scope?: string;
}) {
  const { cardId } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } }, `card-${opts.clientName}`);
  const reg = await register(opts.redirectUris, opts.clientName);
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const redirectUri = opts.useRedirect ?? opts.redirectUris[0];
  const { verifier, challenge } = pkce();
  const params: Record<string, string> = {
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: `st-${opts.clientName}`,
  };
  if (opts.resource) params.resource = opts.resource;
  if (opts.scope) params.scope = opts.scope;
  const requestId = await authorizeRequestId(params);
  const redirectTo = await approve(requestId, cardId);
  // every harness's callback parser reads `code` (+ echoed `state`) from the query
  expect(redirectTo.startsWith(redirectUri)).toBe(true);
  const code = redirectTo.match(/[?&]code=([^&#]+)/)![1];
  expect(redirectTo).toContain(`state=st-${encodeURIComponent(opts.clientName)}`);
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: decodeURIComponent(code),
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id,
  };
  if (opts.resource) form.resource = opts.resource;
  const res = await exchange(form);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; refresh_token?: string; token_type: string };
  expect(body.token_type.toLowerCase()).toBe("bearer");
  return { body, client_id, cardId };
}

/** Raw JSON-RPC POST against an MCP lane with full header control. */
function rpc(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const initBody = (protocolVersion: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "conformance", version: "0.0.1" } },
});

/** Parse a JSON or SSE-framed JSON-RPC response body into the first result object. */
async function rpcResult(res: Response): Promise<any> {
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ctype.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    expect(data.length).toBeGreaterThan(0);
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

async function sdkClient(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "conformance-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// 1. DCR redirect-URI matrix — one registration per harness, exact shapes
// ---------------------------------------------------------------------------

// Sources: report-mcp-harness-verify-2026-06-11 (per-harness sections) + goose/rmcp
// source-read (rmcp 1.7.0 register_client). Ports that are fixed in the client are
// fixed here; "random port" clients get a representative ephemeral port.
const HARNESS_REDIRECTS: Array<{ harness: string; uris: string[] }> = [
  { harness: "claude-code", uris: ["http://localhost:54545/callback"] },
  { harness: "claude-ai-web", uris: ["https://claude.ai/api/mcp/auth_callback"] },
  { harness: "chatgpt", uris: ["https://chatgpt.com/connector/oauth/cb_8f3a91d2", "https://chatgpt.com/connector_platform_oauth_redirect"] },
  { harness: "codex-cli", uris: ["http://127.0.0.1:53682/auth/callback"] },
  { harness: "openclaw", uris: ["http://127.0.0.1:8989/oauth/callback", "http://localhost:8989/oauth/callback"] },
  { harness: "hermes", uris: ["http://127.0.0.1:8765/callback"] },
  { harness: "cursor", uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] },
  { harness: "vscode", uris: ["http://127.0.0.1:33418/", "https://insiders.vscode.dev/redirect"] },
  { harness: "gemini-cli", uris: ["http://localhost:61234/oauth/callback"] },
  { harness: "goose", uris: ["http://127.0.0.1:35535/oauth_callback"] },
  { harness: "opencode", uris: ["http://localhost:48273/callback"] },
  { harness: "amp", uris: ["http://localhost:8976/oauth/callback"] },
  { harness: "factory-droid", uris: ["http://127.0.0.1:49152/callback"] },
];

describe("DCR redirect-URI matrix (one row per harness)", () => {
  for (const { harness, uris } of HARNESS_REDIRECTS) {
    test(`${harness}: registration accepted as a public client`, async () => {
      const res = await register(uris, harness);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.client_id).toBeTruthy();
      expect(body.redirect_uris).toEqual(uris);
      // rmcp/goose, codex, opencode all register token_endpoint_auth_method "none";
      // the AS must answer in kind or strict clients refuse the config
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    });
  }

  test("loopback ports are NOT pinned: same client shape on a different random port still registers", async () => {
    // goose/gemini/codex pick a fresh ephemeral port per login; registration happens each time
    for (const port of [1024, 33333, 65535]) {
      const res = await register([`http://127.0.0.1:${port}/oauth_callback`], "goose");
      expect(res.status).toBe(201);
    }
  });

  test("non-loopback plain-http redirect is refused (the policy line everything above relies on)", async () => {
    const res = await register(["http://example.com/callback"], "evil");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 2. full PKCE flows per redirect family
// ---------------------------------------------------------------------------

describe("authorization-code flows per harness shape", () => {
  test("openclaw: registers BOTH loopback host forms, completes via the localhost form (PR #91451 retry)", async () => {
    const { body } = await fullFlow({
      clientName: "OpenClaw",
      redirectUris: ["http://127.0.0.1:8989/oauth/callback", "http://localhost:8989/oauth/callback"],
      useRedirect: "http://localhost:8989/oauth/callback",
    });
    expect(body.access_token.startsWith("rmt_at_")).toBe(true);
  });

  test("openclaw: the manual --code lane — the code parsed from redirect_to redeems out-of-band", async () => {
    // OpenClaw never receives the browser redirect (no listener); the user pastes the
    // code from the consent screen. Same exchange, different carrier: this asserts the
    // code works when the redirect itself dead-ends.
    const { cardId } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } }, "openclaw-code-lane");
    const reg = await register(["http://127.0.0.1:8989/oauth/callback"], "OpenClaw");
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const requestId = await authorizeRequestId({
      response_type: "code",
      client_id,
      redirect_uri: "http://127.0.0.1:8989/oauth/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const redirectTo = await approve(requestId, cardId);
    // the dashboard success screen surfaces exactly this parse
    const code = decodeURIComponent(redirectTo.match(/[?&]code=([^&#]+)/)![1]);
    const res = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:8989/oauth/callback",
      client_id,
    });
    expect(res.status).toBe(200);
  });

  test("cursor: custom-scheme redirect survives byte-for-byte through error and success paths", async () => {
    const uri = "cursor://anysphere.cursor-mcp/oauth/callback";
    const { body } = await fullFlow({ clientName: "Cursor", redirectUris: [uri] });
    expect(body.access_token).toBeTruthy();
  });

  test("chatgpt: dynamic {callback_id} redirect + resource param round-trip", async () => {
    const uri = "https://chatgpt.com/connector/oauth/cb_77aa00";
    const { body } = await fullFlow({
      clientName: "ChatGPT",
      redirectUris: [uri],
      resource: `${base}/mcp`,
      scope: "mcp",
    });
    // ChatGPT's delete-and-recreate failure mode is the missing refresh token: pin its presence
    expect(body.refresh_token).toBeTruthy();
  });

  test("claude.ai web: fixed https callback, no resource param sent — token still audience-pinned and usable", async () => {
    const { body } = await fullFlow({
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const client = await sdkClient(`${base}/mcp`, { authorization: `Bearer ${body.access_token}` });
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    await client.close();
  });

  test("goose (rmcp 1.7.0): DCR fallback shape — client_name goose, random loopback port, scope from metadata, public client", async () => {
    // source-verified: CIMD unsupported here => rmcp lands in register_client();
    // this is the exact registration + flow it performs against remit
    const { body } = await fullFlow({
      clientName: "goose",
      redirectUris: ["http://127.0.0.1:41927/oauth_callback"],
      resource: `${base}/mcp`,
      scope: "mcp", // rmcp select_scopes picks from scopes_supported: ["mcp"]
    });
    expect(body.access_token.startsWith("rmt_at_")).toBe(true);
  });

  test("CIMD client_id (URL-shaped, unregistered) fails clean at /authorize: 400, no redirect, no 5xx", async () => {
    const u = new URL(`${base}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", "https://goose-docs.ai/oauth/client-metadata.json");
    u.searchParams.set("redirect_uri", "http://127.0.0.1:4242/oauth_callback");
    u.searchParams.set("code_challenge", "x".repeat(43));
    u.searchParams.set("code_challenge_method", "S256");
    const res = await fetch(u, { redirect: "manual", headers: { "x-forwarded-for": freshIp() } });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3. discovery chain — what 401-driven clients walk, field by field
// ---------------------------------------------------------------------------

describe("discovery chain (Claude Code / Codex / ChatGPT / claude.ai walk this)", () => {
  test("bare /mcp 401 advertises resource_metadata; the secret path lane stays silent", async () => {
    const bare = await rpc("/mcp", initBody("2025-11-25"));
    expect(bare.status).toBe(401);
    const www = bare.headers.get("www-authenticate") ?? "";
    expect(www).toContain("Bearer");
    expect(www).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const path = await rpc("/c/not-a-real-secret/mcp", initBody("2025-11-25"));
    expect(path.status).toBe(401);
    expect(path.headers.get("www-authenticate")).toBeNull();
  });

  test("PRM -> AS metadata chain carries every field the strictest clients require", async () => {
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, any>;
    expect(prm.resource).toBe(`${base}/mcp`);
    expect(prm.authorization_servers).toEqual([base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    // ChatGPT + claude.ai hard requirements
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.response_types_supported).toEqual(["code"]);
    expect(as.grant_types_supported).toContain("refresh_token");
    expect(as.registration_endpoint).toBe(`${base}/register`);
    // rmcp/goose strictness: an S256-less list refuses registration; field must exist
    expect(Array.isArray(as.code_challenge_methods_supported)).toBe(true);
    // public clients (every CLI) need `none`
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    // claude.ai CIMD probe reads this and falls back to DCR
    expect(as.client_id_metadata_document_supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. transport fingerprints + edge battery (both lanes)
// ---------------------------------------------------------------------------

describe("transport fingerprints", () => {
  let secret: string;
  let lanePath: string;

  beforeAll(async () => {
    const issued = await issue({ pay: { period: { amount: "10", seconds: 604800 } } }, "transport-card");
    secret = issued.secret;
    lanePath = `/c/${secret}/mcp`;
  });

  // every protocol revision a 2025-26 client may open with
  for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    test(`initialize with protocolVersion ${version} answers on both lanes`, async () => {
      for (const target of [lanePath, "/mcp"]) {
        const headers = target === "/mcp" ? { authorization: `Bearer ${secret}` } : {};
        const res = await rpc(target, initBody(version), headers);
        expect(res.status).toBe(200);
        const msg = await rpcResult(res);
        expect(msg.result.serverInfo.name).toBe("remit");
        expect(typeof msg.result.protocolVersion).toBe("string");
        // Claude Code tool search keys on instructions; cap is 2KB
        expect(typeof msg.result.instructions).toBe("string");
        expect(msg.result.instructions.length).toBeLessThanOrEqual(2048);
      }
    });
  }

  test("MCP-Protocol-Version header on post-init requests is tolerated (2025-06-18+ clients send it)", async () => {
    const res = await rpc(lanePath, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
    expect(res.status).toBe(200);
    const msg = await rpcResult(res);
    expect(Array.isArray(msg.result.tools)).toBe(true);
  });

  test("unexpected Mcp-Session-Id is harmless on the stateless transport", async () => {
    const res = await rpc(lanePath, initBody("2025-11-25"), { "mcp-session-id": "stale-session-from-before-redeploy" });
    expect(res.status).toBeLessThan(500);
  });

  test("notifications/initialized (no id) is accepted", async () => {
    const res = await rpc(lanePath, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect([200, 202].includes(res.status)).toBe(true);
  });

  test("GET (SSE stream open) answers 405 promptly instead of hanging headerless", async () => {
    // claude.ai + Claude Code open a GET notification stream by default; before the
    // routes fix this request hung with no response headers at all (socket leak).
    for (const target of [lanePath, "/mcp"]) {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (target === "/mcp") headers.authorization = `Bearer ${secret}`;
      const res = await fetch(`${base}${target}`, { method: "GET", headers, signal: AbortSignal.timeout(2000) });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toContain("POST");
    }
  });

  test("DELETE (session teardown) never 5xx or hangs", async () => {
    const res = await fetch(`${base}${lanePath}`, { method: "DELETE", signal: AbortSignal.timeout(2000) });
    expect(res.status).toBeLessThan(500);
    if (res.body) await res.body.cancel();
  });

  test("Accept: application/json only (header-sloppy clients) still gets an answer, not a 5xx", async () => {
    const res = await fetch(`${base}${lanePath}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(initBody("2025-11-25")),
    });
    expect(res.status).toBeLessThan(500);
    if (res.body) await res.body.cancel();
  });

  test("JSON-RPC batch (2025-03-26-era clients) gets a non-5xx answer", async () => {
    const res = await rpc(lanePath, [initBody("2025-03-26", 1)]);
    expect(res.status).toBeLessThan(500);
    if (res.body) await res.body.cancel();
  });

  test("oversized body is rejected 413 before parsing, both lanes", async () => {
    // `connection: close` keeps Bun's test fetch off its shared keep-alive pool: large
    // uploads on a REUSED bun-fetch socket spuriously 431 (client artifact; curl on a
    // reused connection, with and without Expect: 100-continue, gets a clean 413).
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { pad: "x".repeat(1 << 21) } });
    for (const [target, headers] of [
      [lanePath, {}],
      ["/mcp", { authorization: `Bearer ${secret}` }],
    ] as const) {
      const res = await fetch(`${base}${target}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", connection: "close", ...headers },
        body: big,
      });
      expect(res.status).toBe(413);
    }
  });

  test("Host-header mismatch is rejected 421 (DNS-rebinding guard active when base is pinned)", async () => {
    const res = await rpc(lanePath, initBody("2025-11-25"), { host: "evil.example.com" });
    expect(res.status).toBe(421);
  });

  test("tools/list: every tool carries title + description + annotations (directory review bar)", async () => {
    const client = await sdkClient(`${base}${lanePath}`);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(4); // card, pay, paid_fetch, issue_subcard, revoke_subcard (+execute on contract cards)
    for (const t of tools) {
      expect(t.title, `tool ${t.name} missing title`).toBeTruthy();
      expect(t.description, `tool ${t.name} missing description`).toBeTruthy();
      expect(t.annotations, `tool ${t.name} missing annotations`).toBeTruthy();
    }
    const card = tools.find((t) => t.name === "card");
    expect(card?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  test("SDK client end-to-end on the bearer lane with an OAuth token", async () => {
    const { body } = await fullFlow({
      clientName: "claude-code-sdk",
      redirectUris: ["http://localhost:54545/callback"],
    });
    const client = await sdkClient(`${base}/mcp`, { authorization: `Bearer ${body.access_token}` });
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "card")).toBe(true);
    await client.close();
  });
});
