# Changelog

All notable changes to remit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.0] - 2026-06-07

Auth model change: the dashboard now authenticates as the USER.

### Added

- **Per-user API auth (Privy session lane)**: `/api/*` accepts the signed-in user's Privy access token as the bearer, verified offline against the app's JWKS (ES256, `iss privy.io`, `aud` = app id; `REMIT_PRIVY_APP_ID`). No Privy app secret and no per-request Privy API call.
- **Onboard proof**: the embedded wallet signs `remit-onboard:v1:<did>` (personal_sign) at onboard, proving key possession bound to that specific Privy login. The DID inside the message makes the signature non-replayable by any other login (covers the case where a signed 7702 authorization later becomes public on-chain). Wallet-to-login bindings are 1:1 and conflict-checked, with a unique index on `users.privy_did` (additive migration).
- **Per-user scoping on every card route**: reads (`/cards`, `/cards/:id`, `/tree`), secret operations (`/url`, `/rotate`) and controls (`/freeze`, `/unfreeze`, `/revoke`) answer only for the authenticated user's own cards; foreign cards are indistinguishable from nonexistent ones. `prepare` is pinned to the session's wallet, `finalize` only accepts the session's own prepare ids, and the server-signed ops (`POST /cards`, `/nuke`) are admin-only.

### Changed

- `REMIT_ADMIN_TOKEN` is now strictly the server-side ops lane (full access, curl/scripts); the admin bearer compare is constant-time.
- Dashboard sends the Privy session token on every API call (`getAccessToken()`), and `NEXT_PUBLIC_REMIT_ADMIN_TOKEN` is gone: the client bundle no longer contains any shared secret.

### Fixed

- `POST /cards/:id/revoke` is now admin-only like its sibling server-signed ops (`POST /cards`, `/nuke`): a Privy session could previously reach an on-chain revocation signed by the server's dev key (the wrong delegator) against its own card.
- Switching Privy accounts in the same browser tab now re-runs onboarding for the new identity instead of looping 403s behind stale React state.
- Dashboard API errors with non-JSON bodies (edge/proxy HTML on 502/503) surface as clean `http <status>` errors instead of raw JSON parse exceptions.

### Removed

- The HTTP basic-auth deployment gate (`packages/dashboard/proxy.ts` and `DASH_BASIC_USER`/`DASH_BASIC_PASS`): it existed solely to shield the admin token embedded in the bundle, and that token no longer exists.

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
