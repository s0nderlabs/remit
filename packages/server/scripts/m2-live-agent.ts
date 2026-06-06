// M2 (part 1): an MCP SDK client acts as the lead agent against the LIVE server:
// pay live -> mint sub-card -> sub-agent pays live (chain-3 on mainnet) -> freeze
// blocks both -> unfreeze. ~0.04 USDC total.
//
// Run: bun run scripts/m2-live-agent.ts  (server must be up on :4070)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127";
const ADMIN = process.env.REMIT_ADMIN_TOKEN!;
const { card_id, card_url } = JSON.parse(
  await Bun.file("/Users/alkautsar/Documents/s0nderlabs/remit/.dev/m2-card.json").text(),
);

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "m2-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const parse = (r: { content?: unknown }) =>
  JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

const api = (path: string, init?: RequestInit) =>
  fetch(`http://localhost:4070/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...init?.headers },
  });

let pass = true;
const check = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
  if (!cond) pass = false;
};

// ---- 1. lead agent connects with nothing but the URL ----
const lead = await connect(card_url);
const tools = (await lead.listTools()).tools.map((t) => t.name).sort();
check("lead connects; tools reflect terms", JSON.stringify(tools) === JSON.stringify(["card", "issue_subcard", "paid_fetch", "pay", "revoke_subcard"]), tools);

const state0 = parse(await lead.callTool({ name: "card", arguments: {} }));
check("card state readable", state0.status === "active" && state0.remaining_this_period === "25");

// ---- 2. lead pays LIVE ----
console.log("\n[lead pays 0.01 USDC live...]");
const t1 = Date.now();
const pay1 = parse(await lead.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "0.01", memo: "M2 lead spend", idempotency_key: `m2-lead-${Date.now()}` } }));
check(`lead pay confirmed in ${((Date.now() - t1) / 1000).toFixed(1)}s`, pay1.status === "confirmed" && !!pay1.tx, { tx: pay1.tx, remaining: pay1.remaining_this_period });

// ---- 3. mint sub-card, sub-agent pays LIVE (chain-3) ----
const minted = parse(await lead.callTool({
  name: "issue_subcard",
  arguments: { name: "M2 sub-agent budget", terms: { pay: { period: { amount: "5", seconds: 86400 } } } },
}));
check("sub-card minted with URL", typeof minted.card_url === "string" && minted.card_url.includes("/c/"));

const sub = await connect(minted.card_url);
console.log("\n[sub-agent pays 0.01 USDC live (chain-3: leaf -> child -> root)...]");
const t2 = Date.now();
const pay2 = parse(await sub.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "0.01", memo: "M2 chain-3 spend", idempotency_key: `m2-sub-${Date.now()}` } }));
check(`chain-3 sub spend confirmed in ${((Date.now() - t2) / 1000).toFixed(1)}s`, pay2.status === "confirmed" && !!pay2.tx, { tx: pay2.tx });

const stateAfter = parse(await lead.callTool({ name: "card", arguments: {} }));
check("parent budget saw the child spend", stateAfter.remaining_this_period === "24.96", stateAfter.remaining_this_period);

// ---- 4. freeze blocks BOTH (free) ----
await api(`/cards/${card_id}/freeze`, { method: "POST" });
const frozenLead = await lead.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "0.01" } });
check("frozen lead refused card_frozen", frozenLead.isError === true && parse(frozenLead).code === "card_frozen");
const frozenSub = await sub.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "0.01" } });
check("frozen parent blocks SUB too", frozenSub.isError === true && parse(frozenSub).code === "card_frozen");
await api(`/cards/${card_id}/unfreeze`, { method: "POST" });
const unfrozen = parse(await lead.callTool({ name: "card", arguments: {} }));
check("unfreeze restores", unfrozen.status === "active");

await sub.close();
await lead.close();

console.log(`\nM2 part 1 ${pass ? "PASS ✅" : "FAIL ❌"}`);
if (!pass) process.exit(1);
