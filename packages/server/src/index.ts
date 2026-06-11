// @remit/server: the one always-on process (Railway).
// Hostname routing on a single Hono app:
//   mcp.remit.s0nderlabs.xyz        -> MCP endpoint (/c/<secret>/mcp) + dashboard API + webhooks
//   facilitator.remit.s0nderlabs.xyz -> erc7710 x402 facilitator (verify/settle/supported) + demo seller
// Facilitator routes use fetch + WebCrypto ONLY (portability rule: 20-min Workers escape hatch).

import { reconcilePending } from "@remit/engine";
import { createApp } from "./app";
import { envInt, realDeps } from "./deps";

const deps = realDeps();
const app = createApp(deps);
const port = envInt("PORT", 4070);

// Reconcile sweep: charges left "pending" (confirm timed out) hold budget until
// settled. Re-check them against chain logs periodically. 0 disables (tests).
const reconcileMs = envInt("REMIT_RECONCILE_INTERVAL_MS", 300_000);
if (reconcileMs > 0) {
  setInterval(() => {
    reconcilePending({ store: deps.store, relayer: deps.relayer }).then(
      (r) => {
        if (r.reconciled) console.log(`[reconcile] settled ${r.reconciled} stuck charge(s)`);
      },
      () => {}, // sweep errors are non-fatal; next tick retries
    );
  }, reconcileMs);
} else {
  console.log("[reconcile] sweep DISABLED (REMIT_RECONCILE_INTERVAL_MS=0): stuck pending charges will hold budget");
}

// Fiat settlement sweep: approved Visa rows the inline kickoff missed (process crash,
// frozen-then-unfrozen card) get re-driven through spend(). Settlement mode only.
if (deps.fiatSettler) {
  const settler = deps.fiatSettler;
  const runSweep = () =>
    settler.sweep().then(
      (r) => {
        if (r.settled) console.log(`[settle] sweep settled ${r.settled} fiat charge(s) (${r.left} left)`);
      },
      () => {}, // sweep errors are non-fatal; next tick retries
    );
  const settleMs = envInt("REMIT_FIAT_SETTLE_INTERVAL_MS", 60_000);
  if (settleMs > 0) setInterval(runSweep, settleMs);
  setTimeout(runSweep, 5_000); // startup pass: crash recovery for rows orphaned mid-settle
}

console.log(`remit server listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
