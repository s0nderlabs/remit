// MCP endpoints, two auth lanes (locked):
//   Lane A (universal): secret in the URL PATH — /c/<secret>/mcp  (Zapier pattern;
//          NEVER query string; the only lane claude.ai-web can use)
//   Lane B (header-capable clients): generic /mcp + Authorization: Bearer <secret>
// Stateless transport: fresh McpServer + transport per request, no session map.

import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { hashCardSecret } from "@remit/engine";
import type { Context } from "hono";
import type { AppDeps } from "../deps";
import { buildMcpServer } from "./server";

export function mcpRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  const serve = async (c: Context, secret: string | undefined) => {
    if (!secret) return c.json({ error: "missing credential" }, 401);
    const card = deps.store.getCardBySecretHash(hashCardSecret(secret));
    if (!card) return c.json({ error: "unknown card" }, 401);
    if (card.status === "revoked" || card.status === "nuked") {
      return c.json({ error: "card revoked" }, 401);
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
