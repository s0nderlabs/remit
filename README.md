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

1. You sign in to the dashboard (Privy embedded wallet, Google login) and issue a card with terms, set by hand in the composer or drafted from a plain-language request by the Venice-powered NL compiler (the model only names tokens, protocols, and merchants; the server resolves every address from its own verified registry, and you still review and sign the draft).
2. The dashboard compiles the terms into onchain caveats (delegation-framework enforcers), your wallet signs the delegation in the browser, the server stores it alongside a fresh agent key that holds nothing.
3. You hand the card URL to any agent (one `claude mcp add`, a Cursor deeplink, a pasted connector URL).
4. When the agent calls `pay`, the server validates the terms, then redeems the delegation through the 1Shot relayer: gasless, on Base mainnet, settled in USDC from your wallet.
5. Every charge lands in the card's ledger with memo, fee, and tx hash.

The agent never sees a private key, never holds a balance, never needs ETH. The first spend even deploys your wallet's 7702 smart-account code automatically in the same transaction.

## What an agent can do with a card

MCP tools, served over Streamable HTTP. The exact set a card exposes matches its capabilities, so the tool list itself is the permission surface (a pay-only card never sees `execute`; a contract-only card never sees `pay`):

| Tool | Purpose |
|---|---|
| `card` | Live state: remaining budget, terms, expiry, recent charges, sub-cards |
| `pay` | Send USDC on Base within the card's limits; blocks until confirmed on-chain |
| `paid_fetch` | Fetch a URL; on HTTP 402 (x402), pay automatically and return the content |
| `fiat_pay` | Buy over Visa rails (simulated: Stripe test-mode Issuing) against the same budget; with settlement on, the receipt carries the on-chain tx |
| `card_credentials` | Reveal the card's test-mode virtual Visa (number/expiry/cvc) so the agent can check out at a merchant; every card auto-links one on first need |
| `execute` | Run scoped contract calls (e.g. approve + swap, stake, mint) atomically in one redemption; only on cards with contract scope |
| `issue_subcard` | Mint a tighter child card for a sub-agent; pay caps and contract scope must both nest inside the parent's |
| `revoke_subcard` | Instantly kill a sub-card (and its descendants) |

Refusals are typed (`over_period_limit`, `merchant_not_allowed`, `price_exceeds_max`, `exceeds_parent_terms`, `target_not_allowed`, `method_not_allowed`, ...) so agents can relay them honestly instead of guessing.

**Contract cards.** A card can be scoped to specific contract targets + method selectors instead of (or alongside) a USDC budget. The agent calls `execute` with either `{target, method, args}` (the server ABI-encodes) or `{target, data}` raw calldata for tuple/array/multicall methods like Uniswap `exactInputSingle`. Targets and selectors outside the card's declared scope are refused before anything reaches the chain, and the on-chain `allowedTargets`/`allowedMethods` enforcers check the same scope again. Method signatures are normalized to their canonical form (`uint` -> `uint256`) so the encoder, the raw-data selector check, and the on-chain enforcer all agree. Safety on contract cards is the target/method allowlist plus `maxUses` and `expiry` (contract calls are not USDC-metered); pair contract scope with a `pay` cap in one composite card when you want both. A contract card can also carry an **allowance token list** (`contract.tokens`: the only tokens it may `approve`, every approval exact-amount pinned on-chain) and a **per-trade ceiling** (`contract.perTradeMax`, capping each USDC approval; v1 enforces the ceiling on USDC legs only). Both narrow subset-only on sub-cards. Calls carry no native ETH value in v1 (the carved leaf caps value at 0 on-chain); payable-with-value is a planned extension.

## Connecting a card to an agent

Three lanes. The first two carry a per-card credential directly; the third is OAuth, where the agent never holds the card secret.

```bash
# Lane A: secret in the URL path (works everywhere, treat the URL as a password)
claude mcp add --transport http remit https://<host>/c/<card-secret>/mcp

# Lane B: bearer header
claude mcp add --transport http remit https://<host>/mcp \
  --header "Authorization: Bearer <card-secret>"
```

Lanes A and B work in Cursor, VS Code, Gemini CLI, Windsurf, claude.ai custom connectors, or any MCP client that speaks Streamable HTTP. Rotate the secret any time from the dashboard; the old URL dies instantly.

Per-harness one-liners for Lane A (commands verified against each client, Jun 2026):

```bash
codex mcp add remit --url https://<host>/c/<card-secret>/mcp
openclaw mcp add remit --url https://<host>/c/<card-secret>/mcp --transport streamable-http  # flag required: omitting it defaults to SSE
hermes mcp add remit --url "https://<host>/c/<card-secret>/mcp"
gemini mcp add -t http remit https://<host>/c/<card-secret>/mcp
goose session --with-streamable-http-extension "https://<host>/c/<card-secret>/mcp"
amp mcp add remit https://<host>/c/<card-secret>/mcp
droid mcp add remit https://<host>/c/<card-secret>/mcp --type http
```

claude.ai web: Customize → Connectors → Add custom connector → paste the card URL (the dashboard's claude.ai chip opens that dialog prefilled). ChatGPT Developer Mode: create a connector with the card URL as No Authentication, or use Lane C for a real auth story.

**Lane C: OAuth 2.1 (card-picker consent).** Add the bare endpoint with no credential:

```bash
claude mcp add --transport http remit https://<host>/mcp
```

The client discovers the OAuth lane (RFC 9728 protected-resource metadata on the `401`), registers itself (Dynamic Client Registration), and opens a browser. You sign in with your existing dashboard login and **pick which card to grant**. The agent receives a short-lived, card-scoped, independently revocable access token, never the raw card secret. This is the lane OAuth-only clients such as **ChatGPT** require; it also works in Claude Code, claude.ai, Cursor, VS Code, Codex, Gemini CLI, Goose, opencode, Amp, and Factory Droid. Clients that complete OAuth out-of-band read the authorization code straight off the consent success screen: OpenClaw finishes with `openclaw mcp login remit --code <code>` (it runs no callback listener), and headless Hermes uses its paste-back flow the same way. The server is a self-hosted OAuth authorization server (public clients, PKCE S256, rotating refresh tokens); revoking the card kills every token issued for it.

## Architecture

Bun monorepo, three packages:

```
packages/
  engine/     pure core: caveat compiler, issuance, spend, redelegation, revocation
  server/     Hono: REST API + MCP endpoint + x402 facilitator + demo seller + Stripe webhook
  dashboard/  Next.js: Privy login, one-screen cockpit (card deck + dossier, light/dark), NL issue modal (client-signed), demo shop
```

Key pieces:

- **Caveat compiler** (`engine/src/compiler.ts`): turns human terms (`{"pay": {"period": {"amount": "25", "seconds": 604800}}}`) into delegation-framework enforcer caveats.
- **NL compiler** (`server/src/venice/`): Venice AI turns a plain-language request into a plan of named entities + numbers; the server resolves every name against its own verified registry (model output can never place an address in a draft) and assembles a `CardTerms` draft for the user to review and sign.
- **Issuance**: server prepares an unsigned delegation, the user's wallet signs it in the browser (prepare/finalize), so the server never holds the user's key for client-signed cards.
- **Spend** (`engine/src/spend.ts`): validates terms server-side, then redeems the delegation chain through the 1Shot Public Relayer (`DelegationManager.redeemDelegations`), attaching the user's EIP-7702 authorization on first spend.
- **Sub-cards**: ERC-7710 redelegations. Caps only narrow. Revoking a parent kills the subtree.
- **Two payment rails off one delegation**: x402 (real USDC, live) and Stripe Issuing real-time auth (test mode, fiat leg simulated honestly).
- **MCP server**: stateless Streamable HTTP, identity = the card credential on every request, no sessions.
- **OAuth lane** (`server/src/oauth/`): a self-hosted OAuth 2.1 authorization server (RFC 9728 + RFC 8414 discovery, RFC 7591 dynamic client registration, PKCE S256, RFC 8707 resource binding, rotating refresh tokens, RFC 7009 revocation). Login and the card-picker consent reuse the existing Privy dashboard session; issued tokens are opaque, card-scoped, hash-stored beside the card secrets, and die when the card is revoked.

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
cp .env.example .env                       # then fill in the two required vars:
# REMIT_MASTER_KEY=<64 hex chars>            encrypts agent keys + card secrets at rest
# REMIT_ADMIN_TOKEN=<random token>           protects the management API

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
| `REMIT_ADMIN_TOKEN` | yes | ops bearer token for the management API (`/api/*`): full access, server-side scripts only, never shipped to a browser |
| `REMIT_PRIVY_APP_ID` | dashboard lane | enables per-user API auth: Privy access tokens verified offline against the app's JWKS; every route scoped to the authenticated user |
| `PORT` | no | server port (default 4070) |
| `REMIT_DB_PATH` | no | SQLite path (default `.dev/remit.sqlite`) |
| `REMIT_RPC_URL` | no | Base RPC (default `https://mainnet.base.org`) |
| `REMIT_PUBLIC_MCP_BASE` | prod | public origin used when rendering card URLs (unset = localhost; also arms the MCP Host allowlist) |
| `REMIT_ALLOWED_HOSTS` | no | extra Host headers accepted on the MCP endpoint (comma-separated; e.g. a platform fallback domain) |
| `REMIT_CORS_ORIGINS` | no | comma-separated allowed origins for the API |
| `REMIT_DEV_USER_PK` | no | dev-only server-custodied user key (server-signed issuance lane) |
| `REMIT_FACILITATOR_BASE` | no | x402 facilitator base URL (defaults to self) |
| `REMIT_SELLER_PAYTO` | no | payout address for the built-in demo seller |
| `REMIT_PAID_FETCH_ALLOW_LOCAL` | no | allow `paid_fetch` to hit local/private hosts (dev only) |
| `REMIT_STRIPE_WEBHOOK_SECRET` | no | Stripe real-time auth webhook signing secret (test mode); unset = the fiat leg answers 503 (disabled) |
| `STRIPE_SECRET_KEY` | no | Stripe TEST-mode secret key (`sk_test_`/`rk_test_` only; anything else is refused); enables `fiat_pay`, `card_credentials`, and the demo shop |
| `REMIT_FIAT_SETTLEMENT` | no | `1` = approved Visa charges settle on-chain as real delegated USDC transfers (see `REMIT_SETTLEMENT_ADDRESS`, `REMIT_FIAT_FEE_HEADROOM`, `REMIT_FIAT_SETTLE_INTERVAL_MS`) |
| `REMIT_SETTLEMENT_ADDRESS` | settlement | recipient of the fiat settlement transfers (validated at boot; default = the fee collector) |
| `VENICE_API_KEY` | no | enables `POST /cards/compile` (plain-language card drafting); unset = the compile endpoint refuses (disabled) |
| `VENICE_MODEL` | with key | Venice model id for the NL compiler; pin it (the fallback default is unvalidated) |
| `REMIT_DASHBOARD_BASE` | OAuth lane | dashboard origin that hosts the OAuth consent (card-picker) page (default `http://localhost:4071`) |
| `REMIT_RECONCILE_INTERVAL_MS` | no | stuck-pending-charge reconcile sweep interval (default 300000; 0 disables) |
| `REMIT_MCP_RATE_LIMIT` / `REMIT_MCP_BAD_SECRET_LIMIT` | no | per-card and per-IP-bad-secret request ceilings per minute (defaults 240 / 30) |
| `REMIT_OAUTH_ACCESS_TTL` / `REMIT_OAUTH_REFRESH_TTL` | no | OAuth access / refresh token lifetimes in seconds (defaults 3600 / 2592000) |
| `REMIT_OAUTH_REDIRECT_HOSTS` | no | if set, restricts OAuth `https` redirect-URI hosts to this allowlist (loopback + custom schemes always allowed; recommended in prod) |
| `REMIT_OAUTH_ACCEPTED_RESOURCES` | no | extra RFC 8707 resource URIs still honored (legacy values during a base-URL migration) |
| `REMIT_TRUST_PROXY_HOPS` | no | trusted proxy hops for client-IP rate limiting (default 1 = Railway edge; 0 disables XFF trust) |
| `NEXT_PUBLIC_PRIVY_APP_ID` / `NEXT_PUBLIC_PRIVY_CLIENT_ID` | dashboard | Privy app credentials (public identifiers, not secrets) |
| `NEXT_PUBLIC_REMIT_API` | dashboard | server API base, e.g. `http://localhost:4070/api` |
| `NEXT_PUBLIC_BASE_RPC` | dashboard | Base RPC for client-side reads |

The dashboard carries **no shared secret**: every API call sends the signed-in user's Privy session token, which the server verifies and scopes. The deployed dashboard origin must be listed in the server's `REMIT_CORS_ORIGINS`.

## Security model

- **Custody**: your funds stay in your wallet. The per-card agent key signs redelegations only; it holds no assets and is encrypted at rest.
- **Dashboard auth**: per-user Privy sessions, verified server-side against the app JWKS. At onboard, the embedded wallet signs `remit-onboard:v1:<did>` to prove key possession bound to that login; from then on, every card route is scoped to the authenticated user's own cards.
- **Issuance integrity**: the server verifies the delegation signature recovers to the delegator on both issuance lanes before persisting a card.
- **Card secrets**: 256-bit, stored hashed; the URL is a credential, rotate it like a password.
- **Limits enforced twice**: server-side at call time (typed refusals) and on-chain by caveat enforcers at redemption.
- **Revocation layers**: freeze (server, reversible) -> revoke (card + subtree, permanent) -> nuke (on-chain nonce bump, kills every delegation ever issued by the wallet). All three are user-operable from the dashboard; on-chain revoke and nuke are signed by the user's own embedded wallet in the browser (an admin leaf delegation) and ride the relayer gaslessly.
- **MCP surface hardening**: Host allowlist (DNS-rebinding guard), per-card and bad-secret rate limits, 1 MiB body cap, secrets never echoed in errors or logs.
- **Stripe leg**: test mode only, by design; the real-time auth webhook answers from cached delegation state within Stripe's 2s window. With settlement enabled, an approved charge settles as a real delegated USDC transfer afterwards (the same enforcers count both rails), and a charge whose settlement cannot land parks `settlement_unconfirmed` and freezes the card rather than ever releasing its budget.

## Built for the MetaMask Smart Accounts x 1Shot API x Venice AI Dev Cook Off (2026)

remit targets the x402 + ERC-7710 track: one delegation governing real crypto payments (x402/USDC on Base mainnet, live) and a simulated fiat card leg (Stripe Issuing test mode), with sub-card redelegation and cascade revocation as the centerpiece, and Venice AI as the natural-language card compiler in the dashboard. Everything in this README, including the mainnet transactions, is reproducible end to end.
