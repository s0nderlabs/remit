# remit

**The agentic card.**

Issue scoped, revocable spending cards from your wallet. Any agent plugs one in and pays within your limits. No keys, no gas, dead the moment you revoke.

Built on MetaMask Smart Accounts (ERC-7710), settled gaslessly by 1Shot, pays the open web with x402, plugs into any agent over MCP.

---

## The idea

Agents need to spend money. Handing an agent your private key is insane; funding a standalone agent wallet loses your custody and your limits. remit takes the model the card industry settled on decades ago and applies it to agents:

- **Your wallet is the account.** Funds never leave it until the moment of payment.
- **The card is a delegation.** A scoped ERC-7710 delegation, signed by your wallet, wrapped in caveats: budget per period, per-transaction max, merchant allowlist, expiry, usage count.
- **The agent holds the card, not the money.** What the agent gets is an MCP endpoint URL. Behind it, the card can spend only what its terms allow.
- **Revoke kills it instantly.** Freeze or revoke a card (or its whole sub-card tree) and every payment from it stops, server-side immediately and on-chain underneath.

```
your wallet (EIP-7702 smart account)
   └── card  ($25/week, expires Jul 6)          ← root delegation, signed by you
        ├── agent A plugs it in over MCP
        └── sub-card ($1/week, one merchant)    ← redelegation, narrower terms
             └── sub-agent B plugs it in
```

## How a payment actually works

1. You sign in to the dashboard (Privy embedded wallet, Google login) and issue a card with terms.
2. The dashboard compiles the terms into onchain caveats (delegation-framework enforcers), your wallet signs the delegation in the browser, the server stores it alongside a fresh agent key that holds nothing.
3. You hand the card URL to any agent (one `claude mcp add`, a Cursor deeplink, a pasted connector URL).
4. When the agent calls `pay`, the server validates the terms, then redeems the delegation through the 1Shot relayer: gasless, on Base mainnet, settled in USDC from your wallet.
5. Every charge lands in the card's ledger with memo, fee, and tx hash.

The agent never sees a private key, never holds a balance, never needs ETH. The first spend even deploys your wallet's 7702 smart-account code automatically in the same transaction.

## What an agent can do with a card

Five MCP tools, served over Streamable HTTP:

| Tool | Purpose |
|---|---|
| `card` | Live state: remaining budget, terms, expiry, recent charges, sub-cards |
| `pay` | Send USDC on Base within the card's limits; blocks until confirmed on-chain |
| `paid_fetch` | Fetch a URL; on HTTP 402 (x402), pay automatically and return the content |
| `issue_subcard` | Mint a tighter child card for a sub-agent; terms must nest inside the parent's |
| `revoke_subcard` | Instantly kill a sub-card (and its descendants) |

Refusals are typed (`over_period_limit`, `merchant_not_allowed`, `price_exceeds_max`, `exceeds_parent_terms`, ...) so agents can relay them honestly instead of guessing.

## Connecting a card to an agent

Two equivalent lanes, both per-card credentials:

```bash
# Lane A: secret in the URL path (works everywhere, treat the URL as a password)
claude mcp add --transport http remit https://<host>/c/<card-secret>/mcp

# Lane B: bearer header
claude mcp add --transport http remit https://<host>/mcp \
  --header "Authorization: Bearer <card-secret>"
```

The same URL works in Cursor, VS Code, Gemini CLI, Windsurf, claude.ai custom connectors, or any MCP client that speaks Streamable HTTP. Rotate the secret any time from the dashboard; the old URL dies instantly.

## Architecture

Bun monorepo, three packages:

```
packages/
  engine/     pure core: caveat compiler, issuance, spend, redelegation, revocation
  server/     Hono: REST API + MCP endpoint + x402 facilitator + demo seller + Stripe webhook
  dashboard/  Next.js: Privy login, card issuance (client-signed), card pages, tree view
```

Key pieces:

- **Caveat compiler** (`engine/src/compile.ts`): turns human terms (`{"pay": {"period": {"amount": "25", "seconds": 604800}}}`) into delegation-framework enforcer caveats.
- **Issuance**: server prepares an unsigned delegation, the user's wallet signs it in the browser (prepare/finalize), so the server never holds the user's key for client-signed cards.
- **Spend** (`engine/src/spend.ts`): validates terms server-side, then redeems the delegation chain through the 1Shot Public Relayer (`DelegationManager.redeemDelegations`), attaching the user's EIP-7702 authorization on first spend.
- **Sub-cards**: ERC-7710 redelegations. Caps only narrow. Revoking a parent kills the subtree.
- **Two payment rails off one delegation**: x402 (real USDC, live) and Stripe Issuing real-time auth (test mode, fiat leg simulated honestly).
- **MCP server**: stateless Streamable HTTP, identity = the card credential on every request, no sessions.

### Contracts (Base mainnet)

| Contract | Address |
|---|---|
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| Stateless7702 delegator impl | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Running it

Requires [bun](https://bun.sh). Real money moves on Base mainnet; use small budgets.

```bash
bun install

# minimal env (see .env.example for the full list)
export REMIT_MASTER_KEY=<64 hex chars>     # encrypts agent keys + card secrets at rest
export REMIT_ADMIN_TOKEN=<random token>    # protects the management API

bun dev                                    # server on :4070
bun run --cwd packages/dashboard dev       # dashboard on :4071
```

Issue a card from the dashboard (Privy login), or via the admin API:

```bash
curl -X POST localhost:4070/api/cards \
  -H "Authorization: Bearer $REMIT_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my agent card","terms":{"pay":{"period":{"amount":"5","seconds":604800}}}}'
# -> { "card_id": ..., "card_url": "http://localhost:4070/c/<secret>/mcp" }
```

Plug the `card_url` into an agent and it can spend.

### Tests

```bash
bun test                 # engine + server suites
bun run typecheck        # per-package tsc
```

### Environment variables

| Var | Required | Purpose |
|---|---|---|
| `REMIT_MASTER_KEY` | yes | 32-byte hex key; encrypts agent keys and card secrets at rest |
| `REMIT_ADMIN_TOKEN` | yes | bearer token for the management API (`/api/*`) |
| `PORT` | no | server port (default 4070) |
| `REMIT_DB_PATH` | no | SQLite path (default `.dev/remit.sqlite`) |
| `REMIT_RPC_URL` | no | Base RPC (default `https://mainnet.base.org`) |
| `REMIT_PUBLIC_MCP_BASE` | no | public origin used when rendering card URLs |
| `REMIT_CORS_ORIGINS` | no | comma-separated allowed origins for the API |
| `REMIT_DEV_USER_PK` | no | dev-only server-custodied user key (server-signed issuance lane) |
| `REMIT_FACILITATOR_BASE` | no | x402 facilitator base URL (defaults to self) |
| `REMIT_SELLER_PAYTO` | no | payout address for the built-in demo seller |
| `REMIT_PAID_FETCH_ALLOW_LOCAL` | no | allow `paid_fetch` to hit local/private hosts (dev only) |
| `REMIT_STRIPE_WEBHOOK_SECRET` | no | Stripe real-time auth webhook signature secret (test mode) |
| `NEXT_PUBLIC_PRIVY_APP_ID` / `NEXT_PUBLIC_PRIVY_CLIENT_ID` | dashboard | Privy app credentials |
| `NEXT_PUBLIC_REMIT_API` | dashboard | server API base, e.g. `http://localhost:4070/api` |
| `NEXT_PUBLIC_REMIT_ADMIN_TOKEN` | dashboard | admin token used by the dashboard (dev posture) |
| `NEXT_PUBLIC_BASE_RPC` | dashboard | Base RPC for client-side reads |
| `DASH_BASIC_USER` / `DASH_BASIC_PASS` | dashboard deploys | server-side only (never `NEXT_PUBLIC_`): HTTP basic auth over the whole dashboard, assets included. Both unset = open (local dev); one set = fail closed. The dashboard's origin must also be in the server's `REMIT_CORS_ORIGINS` |

## Security model

- **Custody**: your funds stay in your wallet. The per-card agent key signs redelegations only; it holds no assets and is encrypted at rest.
- **Card secrets**: 256-bit, stored hashed; the URL is a credential, rotate it like a password.
- **Limits enforced twice**: server-side at call time (typed refusals) and on-chain by caveat enforcers at redemption.
- **Revocation layers**: freeze (server, reversible) -> revoke (card + subtree, permanent) -> nuke (on-chain nonce bump, kills every delegation ever issued by the wallet).
- **Stripe leg**: test mode only, by design; the real-time auth webhook answers from cached delegation state within Stripe's 2s window.

## Built for the MetaMask Smart Accounts x 1Shot API x Venice AI Dev Cook Off (2026)

remit targets the x402 + ERC-7710 track: one delegation governing real crypto payments (x402/USDC on Base mainnet, live) and a simulated fiat card leg (Stripe Issuing test mode), with sub-card redelegation and cascade revocation as the centerpiece. Everything in this README, including the mainnet transactions, is reproducible end to end.
