# Changelog

All notable changes to remit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.1] - 2026-06-06

### Added

- Dashboard deployment gate (`packages/dashboard/proxy.ts`, Next 16 proxy convention): HTTP basic auth over every route AND static asset, since the client bundle embeds the dev-posture admin token. Server-side env (`DASH_BASIC_USER`/`DASH_BASIC_PASS`); both unset = open (local dev), half-configured = fail closed, constant-time credential compare.

### Changed

- `*.tsbuildinfo` untracked and ignored (build state).

## [0.1.0] - 2026-06-06

First sealed release: the full product loop, live-validated on Base mainnet.

### Added

- **Engine** (`@remit/engine`): caveat compiler (human terms -> delegation-framework enforcers), root card issuance (server-signed and client-signed prepare/finalize lanes), spend via 1Shot Public Relayer with EIP-7702 authorization on first spend, sub-card redelegation with narrowing-only terms, freeze/revoke/nuke revocation layers, encrypted-at-rest agent keys and card secrets.
- **Server** (`@remit/server`): Hono app exposing
  - MCP endpoint (stateless Streamable HTTP) with two auth lanes: path secret (`/c/<secret>/mcp`) and bearer (`/mcp`),
  - five MCP tools: `card`, `pay`, `paid_fetch`, `issue_subcard`, `revoke_subcard`, with typed refusals,
  - management REST API (`/api`): onboard, card prepare/finalize, issue, freeze, unfreeze, rotate, revoke, nuke, tree,
  - x402 facilitator (verify + settle, erc7710 transfer method) and a demo 402-protected seller,
  - Stripe Issuing real-time authorization webhook (test mode, sync approve/decline from cached card state).
- **Dashboard** (`@remit/dashboard`, Next.js 16): Privy Google login with silent embedded-wallet creation, automatic EIP-7702 onboarding, client-signed card issuance (the user's wallet signs the delegation in the browser; the server never holds the key), card pages with ledger and sub-card tree.
- **Docs**: self-contained README (product, architecture, security model, env reference), this changelog, `.env.example`.

### Security

- Issuance verifies the delegation signature recovers to the delegator on BOTH lanes (client-signed finalize and server-signed) before persisting a card.
- Stripe real-time auth decisions walk the full ancestor chain (freeze/expiry/maxUses/budget on every ancestor, like the crypto leg) and fail closed on absent amounts and unpersistable charges.

### Validated (Base mainnet, Jun 5-6 2026)

- Full card lifecycle: issue -> connect -> spend -> sub-card -> cascade revoke, through a real MCP client.
- First-spend path: EIP-7702 code deploy + USDC transfer in one atomic gasless transaction via 1Shot.
- x402 paid fetch: 402 challenge -> automatic payment -> settlement -> content, with on-chain receipt.
- Instant revocation: revoked sub-card URL answers 401 immediately.
- Test suites: 75 engine tests, 29 server tests, all green; per-package typecheck clean.
