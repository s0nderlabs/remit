# Changelog

All notable changes to remit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.10.0] - 2026-06-11

The dashboard refined live, round by round: the centered card-deck hero, a real dark mode, a delete lane for dead cards, and a long polish pass over every floating surface. Shipped through a 3-reviewer pass (2 server-side fixes, 5 UI fixes applied).

### Added

- **The card deck**: the carousel is now a stack. The active card sits front and center with its name + status above it; the next card peeks out behind the right edge in one uniform sliver. Navigate by dragging the card, swiping the trackpad (the deck consumes horizontal wheel gestures; the page never rubber-bands), clicking the peek, or the dots; a quiet `+` beside the dots is the only create affordance.
- **Dark mode**, riding the ink family: the page is the brand ink itself (#141417), every surface steps lighter from there, and the card object goes graphite (its silk band stays saturated). Animated sun/moon toggle in the rail; choice persists, OS preference seeds the first visit, no flash on load.
- **Delete for dead cards**: a `delete card` verb on revoked/expired/nuked cards walks the destructive-action modal and calls a new `DELETE /cards/:id` that removes the card, its sub-card tree, and its charge history, and revokes the subtree's OAuth grants. The engine refuses anything live (including any live descendant, checked subtree-wide, not assumed from the revoke cascade). Card pages navigate home after deletion.
- **Venice drafting progress**: while the compiler runs, the intent box locks, a thin accent pulse rides under it, the button carries a spinner, and the minicard's silk flows. Compiler adjustments now land as ONE "venice adjusted the draft" notes panel instead of loose warning strips.
- A custom dropdown (canvas popover, check on the selected option, arrow keys, Escape, click-away and blur close) replaces the native selects.

### Changed

- Floating surfaces got a real elevation system: scrimmed dialogs ride a `--panel` tone, anchored popovers ride `--float` (the page hue itself, lifted by edge + shadow). The profile menu portals to `<body>` (the sticky rail is a stacking context that painted page content over it) and closes on resize.
- The connect overlay reworked: the credential sits in a quiet inset box with an inline copy icon; the harness pill soup became a labeled grid where each row's glyph says what it does (open prefilled vs copy command); rotate is its own quiet action in the foot.
- The issue modal's term sheet regrouped into titled sections (card / pay · usdc / execute · contracts) with hairline rules; orphan fields joined their groups.
- Focus speaks in ink, not halos: inputs lift to canvas with a single quiet border on focus; the UA's colored focus rings are gone. Scrollbars hidden everywhere (scrolling untouched). A real six-arm snowflake on the freeze verb.

### Fixed

- `shortHex(tx, 10, 0)` rendered the FULL hash after the ellipsis (`slice(-0)` is `slice(0)`), spilling tx links out of the revoke/nuke done-modals and the terms-pane signature row. Long tokens now also hard-wrap inside modals as a backstop.
- The wheel listener attached before cards loaded and never re-armed, so trackpad deck navigation silently did nothing on first load.
- CORS allowlist lacked DELETE, so card deletion died in preflight from the dashboard origin.
- A drag release no longer leaks a click that flips the card; deleting the selected card clears the stale selection instead of pointing the deck at a vanished card.

## [0.9.0] - 2026-06-11

The dashboard rebuilt: one screen, one surface, designed against a studio-grade reference. Shipped through a 3-reviewer pre-release pass that confirmed zero behavior loss from the rebuild (every guard from the old UI verified re-established) plus 8 fixes applied.

### Added

- **The slab**: the whole cockpit is one contained surface on a quiet canvas, composed to fit a single viewport with no page scroll. Top zone: the selected card's dossier (status + verbs, the remaining figure with gauge and reset countdown, the period stats) beside the card bay; bottom zone, full width: a 30-day micro-bar spend chart with an ink scrubber + tooltip, the compact charge feed, and collapsible delegation-terms / sub-cards rows whose sheets overlay without moving the fold.
- **Card carousel**: root cards swipe horizontally (scroll-snap, dot indicators, edge peek); selecting a card swaps the entire dossier with a staggered rise, and a revoked card sweeps the whole slab into its dead state. The carousel respects `prefers-reduced-motion`.
- **"A card being born" issue modal**: the single create affordance opens a modal where a plain-language request drafts the terms (Venice compiler), the compiled terms appear as labeled chips while a miniature card materializes, and "review + sign" runs the normal client-signed issuance; a full manual composer stays available behind "set the terms yourself". The issued URL + connect handoff render in place.
- Count-up theater plays once per session (calm daily driver); a `#demo` hash replays the full choreography for filming.

### Changed

- Navigation chrome removed: no navbar, no view tabs; the wordmark and account avatar float over the canvas. Fonts reduced to Funnel Display + Sora (mono and serif faces removed; hex renders in Sora).
- Activity rows show rail chips (x402 / fiat) and receipts inline; the table is gone.

### Fixed

- A connect/rotate credential resolving after the user swiped to another card is dropped instead of opening the overlay with the wrong card's URL.
- The connect reveal no longer shares a disabled-state with freeze/unfreeze; dead code from the old view system removed (orphaned CSS, dead stats computation, unreachable issue affordance); the issue modal focuses its textarea on open.

## [0.8.0] - 2026-06-11

The Stripe demo lane: the simulated Visa leg becomes triggerable, spendable by agents, and (new) settled on-chain. Shipped through a 3-reviewer pre-release pass (11 findings fixed, 5 accepted with rationale) and a live drill: real Stripe test-mode authorizations end to end, three real USDC settlements on Base mainnet.

### Added

- **On-chain fiat settlement** (`REMIT_FIAT_SETTLEMENT=1`): an approved Visa authorization now settles as a REAL delegated USDC transfer from the user's wallet to `REMIT_SETTLEMENT_ADDRESS` through the same delegation and relayer as the crypto leg, so the on-chain enforcers count BOTH rails against one budget. The webhook's 2s decision stays cache-only; a settlement executor drives the webhook's own charge row through the spend pipeline afterwards (one row, no double count; fee headroom reserved at decision time and held in the books). A fiat row never releases its budget: terminal settlement problems park it `settlement_unconfirmed` and freeze the card. Crash-safe: a pre-broadcast claim makes re-drives impossible, and the reconcile sweep resolves ambiguous sends from chain truth.
- **`fiat_pay` MCP tool**: the agent buys over Visa rails (simulated, Stripe test-mode Issuing) against the same budget as its crypto spends; declines carry the real refusal reason; with settlement on, the receipt carries the on-chain tx hash.
- **`card_credentials` MCP tool**: reveals the linked test-mode virtual Visa (number/expiry/cvc) so an agent can check out at a merchant like any human shopper.
- **Demo merchant** ("s0nder supply co."): `/shop` page in the dashboard plus `/shop/products` + `/shop/checkout` server routes. A generic storefront that accepts the test Visa: card matched cheap-key-first (last4 + expiry) then constant-time full compare, rate-limited, PANs never echoed or logged.
- **Stripe REST client** (fetch + form encoding, no SDK) with a hard test-mode-only key gate, and a decision cache so in-process callers surface the webhook's actual approve/decline reason.

### Changed

- Fiat charges persist as kind `fiat` (was `admin`), so the dashboard activity feed renders the fiat rail pill, with the merchant name in the memo.
- Authorization decisions now decline cards carrying an on-chain merchant whitelist (`merchant_scoped_card`): a card-network merchant cannot satisfy an address whitelist.
- Stripe's own pre-webhook decline reasons (e.g. `insufficient_funds` from the test Issuing balance) surface honestly through the tool and shop responses.

### Validated (live, Jun 11 2026)

- Webhook -> approval -> on-chain settlement: three real Base mainnet transactions (agent `fiat_pay`, browser shop checkout), each visible as `fiat | confirmed` with the settlement tx hash on the card ledger.
- Fresh MCP client drill 6/6: status, credentials reveal, settled purchase, over-budget decline, frozen-card decline, ledger state.
- Decline beats exercised at every layer: card budget (`over_period_limit`), frozen card, unknown card, Stripe balance pre-decline.

## [0.7.0] - 2026-06-11

The MCP robustness release: remit's endpoint verified against the live protocol fingerprints of 13 real agent harnesses (Claude Code, claude.ai web, Codex, ChatGPT, OpenClaw, Hermes, Cursor, VS Code, Windsurf, Gemini CLI, Goose, opencode, Amp, Factory Droid), the gaps that sweep surfaced fixed, and the whole surface pinned by a permanent conformance suite. Shipped through the standard 3-reviewer pre-release pass (4 findings, all actioned).

### Added

- **Authorization code on the consent success screen**: clients that run no local OAuth callback listener previously dead-ended after approval (OpenClaw completes with `openclaw mcp login <name> --code <code>`; headless Hermes paste-back works the same way). The success screen now shows the single-use code with a copy button. Loopback redirect targets are never auto-navigated (continue by button, since a dead local port would swallow the code), https and custom-scheme targets still redirect automatically, and a back-button return re-shows the code instead of looping into the dead redirect.
- **Harness conformance suite** (`packages/server/test/conformance.test.ts`, 39 tests): per-harness DCR redirect-URI matrix (fixed ports, random loopback ports, both OpenClaw host forms, ChatGPT's dynamic callback id, Cursor's custom scheme), full PKCE flows per redirect family, the 401 discovery-chain field-by-field, initialize across all four MCP protocol revisions, and an edge battery (stale session ids, batch frames, GET/DELETE, oversized bodies, Host allowlist, missing Accept values).
- **Server `instructions` field**: Claude Code's default-on tool search keys discovery on it (2KB cap); remit now ships a compact routing guide for its tools at initialize.
- **Per-harness connect surfaces**: the claude.ai chip opens the documented prefilled connector dialog, a VS Code one-click install link, codex/openclaw copy-commands (openclaw pinned to `--transport streamable-http`; it defaults to SSE otherwise), and a README install matrix with verified one-liners for seven more CLIs.

### Fixed

- **GET against the MCP endpoint hung forever**: the stateless transport never answered stream-open GETs (claude.ai and Claude Code send them routinely), leaving the client on a headerless socket. Both lanes now answer 405 with `Allow`, which SDK clients treat as "no notification stream offered" and continue over POSTs.
- **Keep-alive socket desync after early-exit responses**: request bodies are drained before the transport runs (an early transport bail used to leave unread bytes that corrupted the next pooled request on the connection), and unread-body 413s carry `Connection: close` so compliant clients retire the socket.

Verified without code changes: the redirect policy already accepts both OpenClaw loopback host forms (127.0.0.1 and localhost, port-agnostic), and Goose (rmcp 1.7.0) falls back to RFC 7591 dynamic registration against remit's CIMD-less authorization server (confirmed at source level), so Goose joins the OAuth column.

## [0.6.0] - 2026-06-11

Three tracks land together: the Venice natural-language card compiler, advanced contract caveats (allowance tokens + a per-trade ceiling), and the dashboard catching up to everything the engine can do. Shipped through a 3-reviewer pre-release pass (13 findings fixed, 1 accepted as-is).

### Added

- **Venice NL-to-card-terms compiler** (`POST /cards/compile` + the dashboard "Draft terms" box): describe the card in plain language and a draft prefills the composer. The model only ever names entities (tokens, protocols, merchants) and numbers; every address is resolved server-side from a verified registry, so model output cannot place an address into a draft. Unresolvable or inexpressible clauses come back as warnings, and the user still reviews and signs through the normal issuance flow.
- **Allowance tokens + per-trade ceiling on contract cards**: a contract card can declare which tokens it may grant allowances for (`contract.tokens`) and a USDC per-trade cap (`contract.perTradeMax`). Approvals outside the token list or above the cap refuse before anything reaches the chain; approve calldata stays exact-amount pinned on-chain. Sub-cards keep tokens subset-only and caps tightest-governs. Validated live with a pinned approve+swap on Base mainnet.
- **Dashboard capability wiring**: the composer exposes the full card surface (max uses, lifetime, contract targets/methods/tokens/per-trade max) as spec-sheet rows; connect moved into an overlay (the card flip stays as object delight); the terms grid derives from the card's real lanes; activity rows attribute charges per card.

### Changed

- Dashboard re-render ("Porcelain"): everything sits on white panels over a tinted canvas, floating pill navbar, mini-card rack under the hero card, zero uppercase anywhere, mono reserved for hex and credentials.

### Fixed

- A per-trade cap on a non-USDC sell leg (which v1 cannot enforce) is dropped from compiled drafts with a warning instead of rendering as a live ceiling; the dashboard headline only presents the cap when the card can actually grant a USDC allowance, and the terms grid marks unenforceable caps as dormant.
- Malformed money amounts (non-numeric, more than 6 decimals) in any terms field refuse with a typed 422 instead of surfacing as a 500.
- The Venice client times out (20s) instead of hanging `/cards/compile` on a silent upstream, and the basescan lookup gets the same guard (8s). JSON extraction from model replies is brace-balance aware so prose braces can't poison the parse, and a garbled per-trade value can never win the tightest-cap selection.
- The composer refuses a token allowance entered without a contract scope instead of silently dropping it from the signed terms.
- The delegation-terms header counts honestly ("N terms on this card" instead of claiming every term is enforced on-chain).
- Sub-cards no longer inherit a per-trade cap they can never trigger (no approve in their scope); the fee leg reuses the shared `feeExecution` helper; dead CSS rules, dead exports, and test scaffolding cleaned up.

## [0.5.0] - 2026-06-08

The contract lane: a card can scope an agent to specific contract calls (swaps, staking, mints), not just USDC payments.

### Added

- **Contract cards + the `execute` tool**: a card can be scoped to specific contract targets and method selectors instead of (or alongside) a USDC budget. The agent calls `execute` with `{target, method, args}` (the server ABI-encodes) or raw `{target, data}` calldata for tuple/array/multicall methods like Uniswap `exactInputSingle`; targets or methods outside the card's declared scope are refused before anything reaches the chain, and the on-chain `allowedTargets`/`allowedMethods` enforcers check the same scope again. Multiple calls redeem atomically in one transaction (e.g. approve + swap). Validated live on Base mainnet across Uniswap swaps, Aave supply/withdraw, ERC20 transfers, contract sub-cards, and composite pay+contract cards.
- **Contract sub-cards**: `issue_subcard` can narrow contract scope (targets and selectors must be a subset of the parent's), so a lead agent hands a sub-agent an even tighter contract card (chain-3 redelegation).
- Method signatures are normalized to their canonical form (`uint` -> `uint256`, whitespace stripped) so the encoder, the raw-data selector check, and the on-chain enforcer always agree; unparseable signatures are rejected at issue.

### Fixed

- **Scope-escape closed**: the fee-leg mechanism unioned `USDC.transfer` into every contract card's on-chain scope, which let a card scoped to e.g. Uniswap also call `USDC.transfer` to move funds. The agent's calls are now validated against the raw declared scope; the fee-leg union stays internal to the redemption.
- **`maxUses` no longer trips early on-chain**: the on-chain `LimitedCallsEnforcer` counts per execution and every redemption appends a fee-leg execution, so a `maxUses:N` card was exhausted on-chain far sooner than `N` redemptions. The on-chain limit is now scaled to the worst-case executions per redemption (contract `x6`, pay/x402 `x2`); `maxUses` is enforced as a redemption count server-side.

### Notes

- Native ETH value on contract calls (payable methods) is deferred to a later release: contract calls carry value 0 (the carved leaf caps value at 0 on-chain).

## [0.4.0] - 2026-06-07

The OAuth lane: OAuth-only MCP clients (notably ChatGPT) can now connect a card.

### Added

- **OAuth 2.1 authorization lane (lane C)**: remit self-hosts the bounded authorization-server profile — RFC 9728 protected-resource metadata (path-aware + root), RFC 8414 AS metadata, open RFC 7591 dynamic client registration, authorization-code grant with PKCE S256 only, public clients (`token_endpoint_auth_method: none`), RFC 8707 resource round-trip with mint-time audience pinning, rotating refresh tokens with family reuse-detection, and RFC 7009 revocation. Adding the bare `/mcp` URL with no credential triggers discovery via `WWW-Authenticate` on the 401.
- **Card-picker consent** (`/connect` on the dashboard): the user signs in with the existing Privy session and picks WHICH card to grant; the agent receives an opaque, short-lived, card-scoped token (sha-256 hash-stored beside the card secrets) and never the raw card secret. Authorization requests are claim-once bound to the first login that opens them; approval is single-use and re-checks card liveness (revoked/nuked/expired all refuse).
- **Token lifecycle tied to the card**: revoking or nuking a card revokes every OAuth grant issued for it (all five revoke/nuke paths cascade); per-token revocation works independently of the card; a replayed authorization code or rotated-out refresh token kills its whole token family.
- OAuth endpoint hardening: per-IP rate limits on register/authorize/token, body caps that also bound chunked requests, redirect-URI policy (https any host unless `REMIT_OAUTH_REDIRECT_HOSTS` restricts it, http loopback-only, custom client schemes allowed), exact-string redirect building that preserves `cursor://`-style URIs, and a consent page that flags the self-reported client name and shows the redirect destination before granting.
- New env knobs: `REMIT_DASHBOARD_BASE` (consent page origin), `REMIT_OAUTH_ACCESS_TTL` / `REMIT_OAUTH_REFRESH_TTL`, `REMIT_OAUTH_REDIRECT_HOSTS`, `REMIT_OAUTH_ACCEPTED_RESOURCES` (legacy audience values during a base-URL migration), `REMIT_OAUTH_*_LIMIT` rate ceilings, `REMIT_TRUST_PROXY_HOPS`.

### Changed

- Bare `/mcp` 401s now carry the `WWW-Authenticate: Bearer resource_metadata="..."` discovery header. The static-secret lanes (`/c/<secret>/mcp` and `Authorization: Bearer <card-secret>`) are byte-for-byte unchanged — a valid credential never 401s, so existing clients never see OAuth at all.
- Client-IP extraction for rate limiting honors `REMIT_TRUST_PROXY_HOPS` instead of hard-coding the single-proxy assumption.

## [0.3.0] - 2026-06-07

Client-signed revocation, MCP hardening, and a correctness pass over the money paths.

### Added

- **Client-signed on-chain revoke and nuke from the dashboard** (the Privy lane): the embedded wallet signs the admin leaf in the browser (prepare -> sign -> finalize, mirroring issuance), the relayer executes it gaslessly. Prepared admin ops are single-use (atomic in-progress claim), TTL'd to 2 minutes (enforced at finalize), and verified to recover to the account owner before anything reaches the relayer. Sub-cards still die server-side instantly (their on-chain delegator is the parent's agent key, honest layering).
- **Per-card connect panel**: copy URL, Claude Code CLI snippet, Cursor one-click deeplink, generic JSON, claude.ai-web instructions, all per card next to the revealed URL.
- **MCP surface hardening**: per-card and per-IP-bad-secret rate limits (trusting only the proxy-appended client IP), Host allowlist (DNS-rebinding guard, missing Host rejected), 1 MiB body cap, MCP tool annotations (read-only/destructive/idempotent/open-world hints).
- **Spend serialization** (`KeyedMutex`): money-moving sections are serialized per card tree, so concurrent spends can't double-pass a budget check; the Stripe webhook stays lock-free (2s window) via a synchronous validate+reserve pair on the crypto side that closes the fiat/crypto race.
- **Reconcile sweep**: charges left `pending` (confirmation timed out) are settled against chain logs periodically; the fee-leg scan is anchored at each charge's broadcast block (immune to sweep downtime), collision-guarded (one log can never confirm two charges), and orphaned x402 reservations are released after a TTL.

### Fixed

- **Sub-card NonceEnforcer binding**: sub-cards now compile their nonce caveat against their own delegator (the parent's agent key, nonce 0), not the user's revocation nonce. Previously, any sub-card issued after a nuke was born dead on-chain (`NonceEnforcer:invalid-nonce`); cascade revocation through the chain is unaffected.
- `paid_fetch` no longer leaks the budget reservation when the paid retry fetch throws (network error / seller down between the 402 and the retry) or the settlement receipt header is malformed.
- A timed-out admin confirmation no longer optimistically marks cards revoked/nuked while the delegation may still be live on-chain; the nuke marks the tree dead before the nonce re-read so an RPC blip can't leave dead cards looking alive.
- Finalizing a stale admin prepare against an already-revoked/nuked card short-circuits instead of burning a relayer fee on a no-op transaction.
- x402 settlements without an on-chain receipt are persisted as `settlement_unconfirmed` (new charge status), matching the receipt the agent gets instead of claiming `confirmed`.
- Optional numeric env vars set to the empty string (the `cp .env.example .env` shape) no longer zero rate limits or silently disable the reconcile sweep.
- Dashboard: the nuke and revoke success states (with the basescan tx proof link) survive the post-operation refresh instead of being unmounted within a second.
- Card expiry is re-checked against a fresh clock before broadcast; freezes/revocations landing mid-pipeline are refused before send.

### Changed

- Stale stored 7702 authorizations (account nonce advanced past the signed nonce) are refused with a clear re-onboard message instead of reverting on-chain.
- Retrying an idempotency key whose charge failed before broadcast re-attempts cleanly; failures that may have reached the chain stay terminal.

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
