// @remit/server: the one always-on process (Railway).
// Hostname routing on a single Hono app:
//   mcp.remit.s0nderlabs.xyz        -> MCP endpoint (/c/<secret>/mcp) + dashboard API + webhooks
//   facilitator.remit.s0nderlabs.xyz -> erc7710 x402 facilitator (verify/settle/supported) + demo seller
// Facilitator routes use fetch + WebCrypto ONLY (portability rule: 20-min Workers escape hatch).

import { createApp } from "./app";
import { realDeps } from "./deps";

const app = createApp(realDeps());
const port = Number(process.env.PORT ?? 3000);

console.log(`remit server listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
