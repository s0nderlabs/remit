// MCP endpoints, two auth lanes (locked):
//   Lane A (universal): secret in the URL PATH — /c/<secret>/mcp  (Zapier pattern;
//          NEVER query string; the only lane claude.ai-web can use)
//   Lane B (header-capable clients): generic /mcp + Authorization: Bearer <secret>
// Stateless transport: fresh McpServer + transport per request, no session map.

import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { hashCardSecret } from "@remit/engine";
import type { Context } from "hono";
import { envInt, type AppDeps } from "../deps";
import { buildMcpServer } from "./server";

// Reject oversized MCP bodies before parsing (cheap DoS guard). 1 MiB is generous for
// JSON-RPC tool calls; paid_fetch returns are server-fetched, never request bodies.
const MAX_BODY_BYTES = 1 << 20;

/** Tiny in-memory sliding-window limiter (single Railway process; no dep). Keyed by
 * client IP for unauthenticated bad-secret attempts, and by card id for authed load. */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  /** returns true if ALLOWED, false if the key is over its limit for the window */
  allow(key: string, nowMs: number): boolean {
    const cutoff = nowMs - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(nowMs);
    this.hits.set(key, arr);
    // opportunistic GC so the map can't grow unbounded
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.every((t) => t <= cutoff)) this.hits.delete(k);
    return true;
  }
}

export function mcpRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  // bad-secret brute-force guard (per IP): 30 rejected attempts / minute
  const badSecret = new RateLimiter(envInt("REMIT_MCP_BAD_SECRET_LIMIT", 30), 60_000);
  // per-card request ceiling: 240 calls / minute (well above any real agent loop)
  const perCard = new RateLimiter(envInt("REMIT_MCP_RATE_LIMIT", 240), 60_000);

  // host allowlist (DNS-rebinding): enforced only when an explicit public base is set.
  // REMIT_ALLOWED_HOSTS (comma-separated) widens it, e.g. the Railway fallback domain.
  // Evaluated per request (cheap) so env changes don't require a route rebuild.
  const allowedHosts = (): Set<string> | null => {
    try {
      const fromBase = process.env.REMIT_PUBLIC_MCP_BASE ? [new URL(process.env.REMIT_PUBLIC_MCP_BASE).host] : [];
      const extra = (process.env.REMIT_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      const all = [...fromBase, ...extra];
      return all.length ? new Set(all) : null;
    } catch {
      return null;
    }
  };

  // RIGHTMOST X-Forwarded-For entry: the edge (Railway) APPENDS the real client IP to
  // the right and never strips client-supplied values, so the leftmost entry is
  // attacker-controlled (rotate it per request -> fresh limiter bucket every guess).
  // Only the proxy-appended tail is trustworthy.
  const clientIp = (c: Context): string =>
    (c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ?? "") ||
    c.req.header("x-real-ip") ||
    "unknown";

  // Drain the (small) request body before an early-return response: an unconsumed POST
  // body left on a keep-alive connection can desync the NEXT request that reuses it.
  // Never used for 413 — not reading the oversized body is the whole point there.
  const drain = (c: Context) => c.req.text().catch(() => {});

  const serve = async (c: Context, secret: string | undefined) => {
    const nowMs = Date.now();

    // DNS-rebinding guard: when a canonical host is configured, reject mismatched Host
    // headers (a rebinding attack points a victim's browser DNS at our IP with its own
    // Host). Non-browser agents send the correct Host, so this is transparent to them.
    // A MISSING Host is rejected too — every legitimate HTTP/1.1+ client sends one.
    const hosts = allowedHosts();
    if (hosts) {
      const host = c.req.header("host");
      if (!host || !hosts.has(host)) {
        await drain(c);
        return c.json({ error: "host not allowed" }, 421);
      }
    }

    // body-size cap (Content-Length fast path; chunked bodies are bounded by the
    // edge/runtime request buffer — this is the cheap pre-parse guard, not the only one)
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

    if (!secret) {
      await drain(c);
      return c.json({ error: "missing credential" }, 401);
    }
    const card = deps.store.getCardBySecretHash(hashCardSecret(secret));
    if (!card) {
      await drain(c);
      // never echo the attempted secret; rate-limit the source
      if (!badSecret.allow(clientIp(c), nowMs)) return c.json({ error: "too many requests" }, 429);
      return c.json({ error: "unknown card" }, 401);
    }
    if (card.status === "revoked" || card.status === "nuked") {
      await drain(c);
      return c.json({ error: "card revoked" }, 401);
    }
    // POST = the actual JSON-RPC calls. The transport's long-lived GET (SSE stream) and
    // its reconnects must not eat the per-card budget, or a flapping stream 429s the
    // agent's own legitimate spends.
    if (c.req.method === "POST" && !perCard.allow(card.id, nowMs)) {
      await drain(c);
      return c.json({ error: "rate limit exceeded for this card" }, 429);
    }
    // frozen cards still ANSWER (locked): `card` reports status, spend tools refuse
    const server = buildMcpServer(deps, card);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c);
  };

  app.all("/c/:secret/mcp", (c) => serve(c, c.req.param("secret")));

  app.all("/mcp", (c) => {
    const m = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    return serve(c, m?.[1]);
  });

  return app;
}
