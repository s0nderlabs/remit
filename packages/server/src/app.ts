// The app factory: ONE Hono process, hostname-routed (locked all-in-Railway shape).
//   mcp.*          -> MCP endpoints + dashboard API + webhooks
//   facilitator.*  -> erc7710 x402 facilitator + demo seller (P3)
// In dev (localhost) every route is reachable on the single host.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { ENGINE_VERSION } from "@remit/engine";
import type { AppDeps } from "./deps";
import { mcpRoutes } from "./mcp/routes";
import { apiRoutes } from "./api/routes";
import { facilitatorRoutes } from "./facilitator/routes";
import { sellerRoutes } from "./seller/routes";
import { stripeRoutes } from "./stripe/routes";

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, engine: ENGINE_VERSION, host: c.req.header("host") ?? null }),
  );

  // dashboard API is browser-consumed (dev: localhost:4071; prod: the Vercel origin)
  app.use(
    "/api/*",
    cors({
      origin: (origin) => {
        const allowed = (process.env.REMIT_CORS_ORIGINS ?? "http://localhost:4071").split(",");
        return allowed.includes(origin) ? origin : null;
      },
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.route("/", mcpRoutes(deps));
  app.route("/api", apiRoutes(deps));
  app.route("/facilitator", facilitatorRoutes(deps));
  app.route("/", stripeRoutes(deps));
  // the demo seller settles through OUR facilitator (same process, real HTTP)
  app.route(
    "/",
    sellerRoutes(deps, () => process.env.REMIT_FACILITATOR_BASE ?? `http://localhost:${process.env.PORT ?? 3000}/facilitator`),
  );

  return app;
}
