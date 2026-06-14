"use client";

// /docs: the reference, in the house style. A quiet left TOC rail (scroll-spy,
// theme toggle + back-to-app at the foot) beside one prose column. Public route,
// no auth: documentation reads the same signed-in or out. Everything here is
// grounded in the actual engine/server/dashboard code, not aspirational.

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { ThemeToggle } from "../components/Theme";
import { IconCheck, IconCopy, copyText } from "../components/ui";

// ---------------------------------------------------------------------------
// Table of contents: grouped into proper sections (drives the nav). The groups
// follow the body's reading order exactly, so the scroll-spy and the clicks
// never jump out of sequence.
// ---------------------------------------------------------------------------

const NAV: { group: string; items: { id: string; label: string }[] }[] = [
  {
    group: "Concepts",
    items: [
      { id: "overview", label: "Overview" },
      { id: "lifecycle", label: "How a Payment Works" },
    ],
  },
  {
    group: "Cards",
    items: [
      { id: "issuing", label: "Issuing a Card" },
      { id: "terms", label: "Card Terms" },
    ],
  },
  {
    group: "Connect",
    items: [
      { id: "connect", label: "Connecting an Agent" },
      { id: "tools", label: "MCP Tools" },
    ],
  },
  {
    group: "Advanced",
    items: [
      { id: "execute", label: "Contract Cards" },
      { id: "subcards", label: "Sub-Cards & Revocation" },
    ],
  },
  {
    group: "Operate",
    items: [
      { id: "rails", label: "Payment Rails" },
      { id: "security", label: "Security" },
    ],
  },
  {
    group: "Reference",
    items: [
      { id: "api", label: "API Reference" },
      { id: "selfhost", label: "Self-Hosting" },
      { id: "cookoff", label: "The Cook Off" },
    ],
  },
];
const FLAT = NAV.flatMap((g) => g.items);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Code({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="doccode">
      <pre>{code}</pre>
      <button
        className={`doccopy${done ? " done" : ""}`}
        aria-label="Copy to clipboard"
        title="Copy"
        onClick={async () => {
          if (await copyText(code)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        }}
      >
        {done ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="doctablewrap">
      <table className="doctable">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Note({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div className={`docnote${warn ? " warn" : ""}`}>
      <span className="ni" aria-hidden>
        {warn ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.6 15 13.5H1z" />
            <path d="M8 6.2v3.6M8 11.6v.1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6.6" />
            <path d="M8 7.4v4M8 4.7v.1" />
          </svg>
        )}
      </span>
      <p>{children}</p>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="docsec" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const [active, setActive] = useState(FLAT[0].id);

  // scroll-spy: highlight the section whose top sits in the upper band of the viewport
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-12% 0px -72% 0px", threshold: 0 },
    );
    for (const s of FLAT) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  return (
    <div className="docs">
      {/* the aurora: subtle page weather behind the chrome */}
      <div className="docaurora" aria-hidden>
        <i className="docbeamA" />
        <i className="docbeamB" />
        <i className="docbeamC" />
      </div>
      <aside className="docnav">
        <Link className="brand" href="/">
          remit
        </Link>
        <span className="docnavlabel">Documentation</span>
        <nav className="docnavlist">
          {NAV.map((g) => (
            <Fragment key={g.group}>
              <div className="docnavgroup">{g.group}</div>
              {g.items.map((s) => (
                <a key={s.id} className={`docnavitem${active === s.id ? " on" : ""}`} href={`#${s.id}`}>
                  {s.label}
                </a>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="docnavfoot">
          <ThemeToggle />
          <Link className="docback" href="/">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span>Open the App</span>
          </Link>
        </div>
      </aside>

      <main className="docbody">
        <div className="docwrap">
          {/* hero */}
          <header className="dochero">
            <span className="doceyebrow">The agentic card</span>
            <h1>Documentation</h1>
            <p className="docsub">
              remit issues scoped, revocable spending cards from your wallet. Any agent plugs one in over MCP and
              pays within your limits, holding no keys and no funds, dead the moment you revoke. Here is how it
              works, end to end.
            </p>
          </header>

          {/* ---- Overview ---- */}
          <Section id="overview" title="Overview">
            <p className="docp">
              Agents need to spend money. Handing an agent your private key is reckless; funding a standalone agent
              wallet loses both your custody and your limits. remit takes the model the card industry settled on
              decades ago and applies it to agents: the wallet stays the account, and the agent gets a <b>card</b>,
              a scoped authority to draw from it.
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Your wallet is the account.</b> Funds never leave it until the moment of payment.
              </li>
              <li className="docli">
                <b>The card is a delegation.</b> A scoped ERC-7710 delegation, signed by your wallet, wrapped in
                caveats: budget per period, per-transaction cap, merchant allowlist, expiry, usage count, contract
                scope.
              </li>
              <li className="docli">
                <b>The agent holds the card, not the money.</b> What the agent gets is an MCP endpoint URL. Behind
                it, the card can spend only what its terms allow, signed by an agent key that holds nothing.
              </li>
              <li className="docli">
                <b>Revoke kills it instantly.</b> Freeze or revoke a card (or its whole sub-card tree) and every
                payment stops, server-side immediately and on-chain underneath.
              </li>
            </ul>

            <div className="docdiagram">
              {`your wallet  `}<span className="mut">(EIP-7702 smart account)</span>{`
   └── `}<b>card</b>{`   `}<span className="mut">$25 / week · expires Jul 6</span>{`        ← root delegation, signed by you
        ├── agent A plugs it in over MCP
        └── `}<b>sub-card</b>{`   `}<span className="mut">$1 / week · one merchant</span>{`   ← redelegation, narrower terms
             └── sub-agent B plugs it in`}
            </div>

            <p className="docp">
              remit runs on <b>Base mainnet</b> with real USDC. The only simulated leg is the Visa rail (Stripe
              test-mode Issuing), labeled honestly wherever it appears.
            </p>

            <div className="docfacts">
              <div className="docfact">
                <div className="fk">Dashboard</div>
                <div className="fv">
                  <a href="https://remit.s0nderlabs.xyz" target="_blank" rel="noreferrer">
                    remit.s0nderlabs.xyz
                  </a>
                </div>
              </div>
              <div className="docfact">
                <div className="fk">API + MCP</div>
                <div className="fv">
                  <a href="https://remit-api.s0nderlabs.xyz" target="_blank" rel="noreferrer">
                    remit-api.s0nderlabs.xyz
                  </a>
                </div>
              </div>
              <div className="docfact">
                <div className="fk">Demo merchant</div>
                <div className="fv">
                  <a href="https://shop.s0nderlabs.xyz" target="_blank" rel="noreferrer">
                    shop.s0nderlabs.xyz
                  </a>
                </div>
              </div>
            </div>
          </Section>

          {/* ---- Lifecycle ---- */}
          <Section id="lifecycle" title="How a Payment Works">
            <ul className="docul">
              <li className="docli">
                You sign in to the dashboard (Privy embedded wallet, Google or email) and issue a card with terms,
                set by hand in the composer or drafted from plain language by the Venice-powered compiler.
              </li>
              <li className="docli">
                The dashboard compiles those terms into on-chain caveats, your wallet signs the delegation in the
                browser, and the server stores it alongside a fresh agent key that holds nothing.
              </li>
              <li className="docli">
                You hand the card URL to any agent (one <code>claude mcp add</code>, a Cursor deeplink, a pasted
                connector URL).
              </li>
              <li className="docli">
                When the agent calls <code>pay</code>, the server validates the terms, then redeems the delegation
                through the 1Shot Public Relayer: gasless, on Base mainnet, settled in USDC from your wallet.
              </li>
              <li className="docli">
                Every charge lands in the card&apos;s ledger with memo, fee, and tx hash, attributed to the agent
                key that spent it.
              </li>
            </ul>
            <Note>
              The agent never sees a private key, never holds a balance, never needs ETH. The first spend even
              deploys your wallet&apos;s EIP-7702 smart-account code automatically, attached to the same redemption
              as an authorization list.
            </Note>
          </Section>

          {/* ---- Issuing ---- */}
          <Section id="issuing" title="Issuing a Card">
            <p className="docp">
              A card is born from a <code>CardTerms</code> object: a <code>pay</code> budget, a <code>contract</code>{" "}
              scope, or both, plus lifecycle limits (expiry, max uses, per-charge cap, merchant lock, sub-cards
              on/off). You can write the terms by hand in the composer, or describe the card in plain language and let
              the compiler draft them.
            </p>
            <h3>The plain-language compiler</h3>
            <p className="docp">
              The dashboard&apos;s issue modal sends your sentence to Venice AI, which returns a plan of named
              entities (&quot;USDC&quot;, &quot;Uniswap&quot;, &quot;aave&quot;) and numbers. The server then
              resolves every name against its own verified registry (or Basescan, or your own pasted address), so the
              model output can never place a raw address into a draft. The result is a <code>CardTerms</code> draft
              you review and sign; nothing is issued until you do.
            </p>
            <Note>
              The compiler only <b>names</b> tokens, protocols and merchants. Addresses come exclusively from the
              trusted resolvers or your own text, with provenance shown on each chip (registry, Basescan, or your
              input). A draft cannot smuggle a poisoned address even if the model tries.
            </Note>
            <h3>The client-signed ceremony</h3>
            <p className="docp">
              Issuance is a three-step prepare / sign / finalize so the server never holds your key:
            </p>
            <ul className="docul">
              <li className="docli">
                <b>prepare</b> — the server compiles the caveats, mints the agent key, and returns the exact unsigned
                delegation struct.
              </li>
              <li className="docli">
                <b>sign</b> — your embedded wallet signs the EIP-712 delegation in the browser.
              </li>
              <li className="docli">
                <b>finalize</b> — the server verifies the signature recovers to your wallet, then persists the card
                and returns its URL.
              </li>
            </ul>
          </Section>

          {/* ---- Terms ---- */}
          <Section id="terms" title="Card Terms">
            <p className="docp">
              Each term compiles to a delegation-framework enforcer caveat at the root of the delegation, so the
              chain enforces the same limits the server checks. Below is the exact mapping
              (<code>engine/src/compiler.ts</code>).
            </p>
            <Table
              head={["Term", "Meaning", "On-chain enforcer"]}
              rows={[
                [
                  <code key="a">pay.period</code>,
                  "Budget per rolling window (amount + seconds, min 60s)",
                  <code key="b">ERC20PeriodTransfer</code>,
                ],
                [<code key="a">pay.lifetime</code>, "Total USDC the card may ever move", <code key="b">ERC20TransferAmount</code>],
                [<code key="a">contract.targets</code>, "Contracts the card may call", <code key="b">AllowedTargets</code>],
                [<code key="a">contract.selectors</code>, "Method signatures the card may call", <code key="b">AllowedMethods</code>],
                [<code key="a">expiry</code>, "Unix time after which nothing redeems", <code key="b">Timestamp</code>],
                [
                  <code key="a">maxUses</code>,
                  "Redemption count (scaled to executions on-chain; server is the binding limit)",
                  <code key="b">LimitedCalls</code>,
                ],
                [
                  "revocation nonce",
                  "Always present; bumping it nukes every card from this wallet",
                  <code key="b">Nonce</code>,
                ],
                [
                  "pay + contract",
                  "A composite card; one group governs each redemption",
                  <code key="b">LogicalOrWrapper</code>,
                ],
              ]}
            />
            <Note>
              <b>perTxMax</b> and <b>merchants</b> are not root caveats; they collide with the mandatory fee leg
              there. They are server-side carve policy applied at redemption: the per-transaction max is backstopped
              on-chain by the carved leaf&apos;s amount scope, while the merchant allowlist is enforced server-side.{" "}
              <b>contract.tokens</b> and <b>contract.perTradeMax</b> additionally pin each ERC-20 allowance to an exact
              spender and amount via byte-window <code>AllowedCalldata</code> caveats on that leaf.
            </Note>
          </Section>

          {/* ---- Connect ---- */}
          <Section id="connect" title="Connecting an Agent">
            <p className="docp">
              The card is served over MCP (Streamable HTTP). There are three connection lanes. The first two carry a
              per-card credential directly; the third is OAuth, where the agent never holds the card secret.
            </p>
            <div className="doclanes">
              <div className="doclane">
                <div className="doclanehd">
                  <span className="lanek">A</span>
                  <span className="lt">Secret in the URL path</span>
                </div>
                <p>
                  Works everywhere, including credential-free clients like claude.ai web. The URL is the password,
                  treat it like one.
                </p>
                <Code code={`claude mcp add --transport http remit \\
  https://<host>/c/<card-secret>/mcp`} />
              </div>
              <div className="doclane">
                <div className="doclanehd">
                  <span className="lanek">B</span>
                  <span className="lt">Bearer header</span>
                </div>
                <p>For clients that send an Authorization header. The bare endpoint, secret in the header.</p>
                <Code code={`claude mcp add --transport http remit \\
  https://<host>/mcp \\
  --header "Authorization: Bearer <card-secret>"`} />
              </div>
              <div className="doclane">
                <div className="doclanehd">
                  <span className="lanek">C</span>
                  <span className="lt">OAuth 2.1 (card-picker consent)</span>
                </div>
                <p>
                  Add the bare endpoint with no credential. The client discovers the OAuth lane, registers itself,
                  and opens a browser; you sign in and pick which card to grant. The agent receives a short-lived,
                  card-scoped, independently revocable token, never the raw secret. This is the lane OAuth-only
                  clients such as ChatGPT require.
                </p>
                <Code code={`claude mcp add --transport http remit https://<host>/mcp`} />
              </div>
            </div>

            <h3>Per-harness one-liners (Lane A)</h3>
            <Code code={`codex     mcp add remit --url https://<host>/c/<secret>/mcp
openclaw  mcp add remit --url https://<host>/c/<secret>/mcp --transport streamable-http
gemini    mcp add -t http remit https://<host>/c/<secret>/mcp
goose     session --with-streamable-http-extension "https://<host>/c/<secret>/mcp"
amp       mcp add remit https://<host>/c/<secret>/mcp
droid     mcp add remit https://<host>/c/<secret>/mcp --type http`} />
            <p className="docp">
              Lanes A and B work in Cursor, VS Code, claude.ai custom connectors, or any MCP client that speaks
              Streamable HTTP. The dashboard&apos;s connect panel renders a prefilled install affordance per harness.
              Rotate the secret any time from the dashboard; the old URL dies instantly.
            </p>
          </Section>

          {/* ---- Tools ---- */}
          <Section id="tools" title="MCP Tools">
            <p className="docp">
              The tool list a card exposes <b>is</b> its permission surface: a pay-only card never sees{" "}
              <code>execute</code>; a contract-only card never sees <code>pay</code>; a sub-cards-off card never sees{" "}
              <code>issue_subcard</code>. The server is stateless, a fresh instance per request, identity = the card
              credential.
            </p>
            <Table
              head={["Tool", "On", "Purpose"]}
              rows={[
                [<code key="t">card</code>, "Every card", "Live state: remaining budget, terms, expiry, recent charges, sub-cards. Call it first."],
                [<code key="t">pay</code>, "pay cards", "Send USDC on Base within limits; blocks until confirmed on-chain."],
                [<code key="t">paid_fetch</code>, "pay cards", "Fetch a URL; on HTTP 402 (x402), pay automatically and return the content."],
                [<code key="t">fiat_pay</code>, "pay + Stripe", "Buy over Visa rails (simulated) against the same budget."],
                [<code key="t">card_credentials</code>, "pay + Stripe", "Reveal the test-mode virtual Visa for a merchant checkout."],
                [<code key="t">execute</code>, "contract cards", "Run scoped contract calls (approve + swap, stake, mint) atomically in one redemption."],
                [<code key="t">issue_subcard</code>, "sub-cards on", "Mint a tighter child card for a sub-agent; returns its URL."],
                [<code key="t">revoke_subcard</code>, "sub-cards on", "Instantly kill a sub-card and its descendants (server-side)."],
              ]}
            />
            <h3>Typed refusals</h3>
            <p className="docp">
              Refusals come back as <code>isError</code> with structured JSON naming the violated term, so an agent
              can relay them honestly instead of guessing. The codes include:
            </p>
            <ul className="docul">
              <li className="docli">
                <code>over_period_limit</code>, <code>merchant_not_allowed</code>, <code>price_exceeds_max</code> — pay
                and paid_fetch
              </li>
              <li className="docli">
                <code>target_not_allowed</code>, <code>method_not_allowed</code>, <code>per_trade_exceeded</code> —
                execute
              </li>
              <li className="docli">
                <code>exceeds_parent_terms</code> — issue_subcard; <code>not_your_subcard</code> — revoke_subcard
              </li>
              <li className="docli">
                <code>card_frozen</code>, <code>no_fiat_card</code> — the fiat leg; <code>invalid_terms</code> — bad
                input
              </li>
            </ul>
          </Section>

          {/* ---- Execute / contract cards ---- */}
          <Section id="execute" title="Contract Cards">
            <p className="docp">
              A card can be scoped to specific contract targets and method selectors instead of (or alongside) a USDC
              budget. The agent calls <code>execute</code> with either <code>{`{target, method, args}`}</code> (the
              server ABI-encodes the calldata) or <code>{`{target, data}`}</code> raw calldata for tuple/array/
              multicall methods like Uniswap <code>exactInputSingle</code>.
            </p>
            <ul className="docul">
              <li className="docli">
                Targets and selectors outside the card&apos;s declared scope are refused before anything reaches the
                chain; the on-chain <code>AllowedTargets</code> / <code>AllowedMethods</code> enforcers check the same
                scope again at redemption.
              </li>
              <li className="docli">
                Method signatures are normalized to canonical form (<code>uint</code> → <code>uint256</code>) so the
                encoder, the raw-data selector check, and the on-chain enforcer all agree.
              </li>
              <li className="docli">
                A contract card can carry an <b>allowance token list</b> (<code>contract.tokens</code>: the only
                tokens it may <code>approve</code>, each approval exact-amount pinned on-chain) and a{" "}
                <b>per-trade ceiling</b> (<code>contract.perTradeMax</code>, capping each USDC approval).
              </li>
              <li className="docli">
                Contract calls carry no native ETH value in v1 (the carved leaf caps value at 0 on-chain); up to 5
                calls batch atomically into one redemption.
              </li>
            </ul>
            <Note>
              Contract calls are not USDC-metered. Safety on a contract card is the target/method allowlist plus{" "}
              <code>maxUses</code> and <code>expiry</code>. Pair contract scope with a <code>pay</code> cap in one
              composite card when you want both rails under one delegation.
            </Note>
          </Section>

          {/* ---- Sub-cards & revocation ---- */}
          <Section id="subcards" title="Sub-Cards & Revocation">
            <p className="docp">
              Sub-cards are ERC-7710 redelegations. An agent holding a card can mint a tighter child for a sub-agent
              with <code>issue_subcard</code>; every term must fit inside the parent&apos;s (caps only narrow
              downward, contract scope is subset-only, never silently inherited). <code>exceeds_parent_terms</code>{" "}
              names the violating field. The chain enforces the same subset via the delegation chain.
            </p>
            <h3>Three layers of off-switch</h3>
            <Table
              head={["Layer", "Effect", "Where"]}
              rows={[
                ["Freeze", "Reversible pause; the card still answers card but refuses spends", "Server-side, instant"],
                ["Revoke", "Permanent; the card and its whole sub-card subtree die", "On-chain disableDelegation, signed by your wallet"],
                ["Nuke", "Kills every card and sub-card this wallet ever issued", "One on-chain NonceEnforcer bump"],
              ]}
            />
            <p className="docp">
              All three are user-operable from the dashboard. On-chain revoke and nuke are signed by your own embedded
              wallet in the browser (an admin leaf delegation) and ride the relayer gaslessly. Revoking a parent kills
              the subtree; the cascade is the demo money-shot, revoke the root and the whole tree dies on screen.
            </p>
            <Note>
              An agent&apos;s own <code>revoke_subcard</code> is a server-side kill: instant, and the sub-card&apos;s
              URL dies, but a sub-card cannot be disabled on-chain on its own (its on-chain delegator is the
              parent&apos;s agent key). On-chain permanence for a whole branch comes from revoking the root card or
              nuking.
            </Note>
          </Section>

          {/* ---- Rails ---- */}
          <Section id="rails" title="Payment Rails">
            <p className="docp">Two payment rails run off one delegation, metered by the same enforcers.</p>
            <h3>x402 (real, live)</h3>
            <p className="docp">
              <code>paid_fetch</code> answers an HTTP 402 challenge by paying through the card&apos;s 7710 delegation:
              real x402 v2 flows on Base mainnet, USDC settled from your wallet. remit also ships the first ERC-7710
              x402 facilitator (<code>/facilitator/verify</code>, <code>/settle</code>, <code>/supported</code>) and a
              demo seller at <code>/demo/premium-data</code> whose 402 points back at it.
            </p>
            <h3>Stripe Issuing Visa (simulated)</h3>
            <p className="docp">
              <code>fiat_pay</code> and <code>card_credentials</code> drive a test-mode virtual Visa. When a charge is
              authorized, Stripe calls remit&apos;s real-time auth webhook, which answers approve/decline from the
              card&apos;s on-chain delegation state inside Stripe&apos;s hard 2-second window (read from a cached
              snapshot, never an RPC call in the handler). A decline comes back typed, from the card&apos;s terms, not
              the merchant.
            </p>
            <p className="docp">
              With settlement enabled, an approved Visa charge then settles as a <b>real delegated USDC transfer</b>{" "}
              on Base, through the same enforcers that meter the crypto rail. One budget, two rails. A charge whose
              settlement cannot land parks <code>settlement_unconfirmed</code> and freezes the card rather than ever
              releasing its budget.
            </p>
            <Note warn>
              The Visa leg is <b>simulated by design</b>: Stripe test-mode Issuing, no real merchant, no KYC required
              in test. It is labeled honestly everywhere it appears. The crypto rail and the on-chain settlement move
              real USDC on Base mainnet.
            </Note>
            <p className="docp">
              The demo merchant, <b>s0nder supply co.</b> at <code>/shop</code>, is a real storefront that accepts the
              cards&apos; Visas. The catalog is priced at $5 or less because approved purchases move real USDC.
            </p>
          </Section>

          {/* ---- Security ---- */}
          <Section id="security" title="Security">
            <ul className="docul">
              <li className="docli">
                <b>Custody.</b> Your funds stay in your wallet. The per-card agent key signs redelegations only; it
                holds no assets and is encrypted at rest.
              </li>
              <li className="docli">
                <b>Dashboard auth.</b> Per-user Privy sessions, verified server-side against the app JWKS. At onboard,
                the embedded wallet signs <code>remit-onboard:v1:&lt;did&gt;</code> to bind the wallet to that login;
                every card route is then scoped to the authenticated user&apos;s own cards.
              </li>
              <li className="docli">
                <b>Issuance integrity.</b> The server verifies the delegation signature recovers to the delegator
                before persisting a card.
              </li>
              <li className="docli">
                <b>Card secrets.</b> 256-bit, stored as a hash for auth and AES-256-GCM-encrypted at rest for the
                reveal/rotate feature. The URL is a credential; rotate it like a password.
              </li>
              <li className="docli">
                <b>Limits enforced twice.</b> Server-side at call time (typed refusals) and on-chain at redemption.
                Period, lifetime, expiry, usage count and contract target/method have dedicated on-chain enforcers; the
                per-transaction max and merchant allowlist are server-side policy, backstopped on-chain by the carved
                leaf&apos;s amount scope.
              </li>
              <li className="docli">
                <b>MCP surface hardening.</b> Host allowlist (DNS-rebinding guard), per-card and bad-secret rate
                limits, a 1 MiB body cap, an SSRF guard on <code>paid_fetch</code> targets, secrets never echoed in
                errors or logs.
              </li>
              <li className="docli">
                <b>OAuth tokens.</b> Opaque, card-scoped, hash-stored beside the card secrets, audience-pinned (RFC
                8707), and revoked the instant the card is, cascading to the subtree.
              </li>
            </ul>
          </Section>

          {/* ---- API reference ---- */}
          <Section id="api" title="API Reference">
            <p className="docp">
              The server is one Hono process. The dashboard API lives under <code>/api</code>; the MCP endpoint,
              OAuth lane, x402 facilitator and demo surfaces sit at the root.
            </p>
            <h3>Auth lanes (every /api route)</h3>
            <ul className="docul">
              <li className="docli">
                <b>Admin</b> — <code>Authorization: Bearer &lt;REMIT_ADMIN_TOKEN&gt;</code>: full access, server-side
                scripts only, never shipped to a browser.
              </li>
              <li className="docli">
                <b>Privy</b> — <code>Authorization: Bearer &lt;Privy access token&gt;</code>, verified offline against
                the app JWKS; every route scoped to the authenticated user.
              </li>
            </ul>
            <h3>Dashboard API (/api)</h3>
            <Table
              head={["Method · Path", "Purpose"]}
              rows={[
                [<code key="p">POST /onboard</code>, "Register the embedded wallet + its 7702 auth + onboard proof"],
                [<code key="p">POST /cards/prepare</code>, "Compile caveats, mint the agent key, return the unsigned delegation"],
                [<code key="p">POST /cards/finalize</code>, "Attach the browser signature, persist the card, return its URL"],
                [<code key="p">POST /cards/compile</code>, "Venice NL → draft CardTerms (never issues)"],
                [<code key="p">GET /cards</code>, "List the user's cards"],
                [<code key="p">GET /cards/:id</code>, "Card detail + charge ledger"],
                [<code key="p">GET /tree</code>, "The card → sub-card tree"],
                [<code key="p">GET /cards/:id/url</code>, "Reveal the card URL"],
                [<code key="p">POST /cards/:id/rotate</code>, "Rotate the card secret (old URL dies)"],
                [<code key="p">GET /cards/:id/fiat</code>, "The linked test-mode Visa (owner view)"],
                [<code key="p">POST /cards/:id/freeze · /unfreeze</code>, "Reversible server-side pause / resume"],
                [<code key="p">POST /cards/:id/revoke/prepare · /finalize</code>, "Client-signed on-chain revoke (sub-cards die server-side)"],
                [<code key="p">POST /nuke/prepare · /finalize</code>, "Client-signed cascade nuke of every card"],
                [<code key="p">DELETE /cards/:id</code>, "Bookkeeping removal of a dead card + its subtree"],
                [<code key="p">GET /oauth/request · POST /oauth/approve · /deny</code>, "The card-picker consent backend"],
              ]}
            />
            <h3>OAuth 2.1 (self-hosted authorization server)</h3>
            <p className="docp">
              Public clients, PKCE S256, auth-code + rotating refresh, dynamic client registration. Tokens are opaque
              (<code>rmt_at_</code> access, <code>rmt_rt_</code> refresh), audience-pinned, and die with the card.
            </p>
            <Table
              head={["Endpoint", "Spec"]}
              rows={[
                [<code key="o">GET /.well-known/oauth-protected-resource/mcp</code>, "RFC 9728 protected-resource metadata"],
                [<code key="o">GET /.well-known/oauth-authorization-server</code>, "RFC 8414 AS metadata"],
                [<code key="o">POST /register</code>, "RFC 7591 dynamic client registration"],
                [<code key="o">GET /authorize</code>, "Validates, then 302s to the dashboard card-picker"],
                [<code key="o">POST /token</code>, "authorization_code + refresh_token grants, PKCE S256"],
                [<code key="o">POST /revoke</code>, "RFC 7009 revocation (kills the whole token family)"],
              ]}
            />
            <h3>MCP, facilitator + demo</h3>
            <Table
              head={["Endpoint", "Purpose"]}
              rows={[
                [<code key="m">ALL /c/:secret/mcp</code>, "Lane A — secret in the path"],
                [<code key="m">ALL /mcp</code>, "Lane B (bearer) + Lane C (OAuth token)"],
                [<code key="m">GET /supported · POST /verify · /settle</code>, "The ERC-7710 x402 facilitator (under /facilitator)"],
                [<code key="m">GET /demo/premium-data</code>, "x402-protected demo seller (0.01 USDC)"],
                [<code key="m">GET /shop/products · POST /shop/checkout</code>, "The demo merchant API"],
                [<code key="m">GET /health</code>, "Liveness + engine version"],
              ]}
            />
          </Section>

          {/* ---- Self-hosting ---- */}
          <Section id="selfhost" title="Self-Hosting">
            <p className="docp">
              A Bun monorepo, three packages: <code>engine</code> (the pure card engine), <code>server</code> (Hono:
              REST + MCP + facilitator + Stripe webhook + demo shop) and <code>dashboard</code> (Next.js). Real money
              moves on Base mainnet, so use small budgets.
            </p>
            <Code code={`bun install
cp .env.example .env          # then set the two required vars below

bun dev                       # server on :4070
bun run --cwd packages/dashboard dev   # dashboard on :4071`} />
            <h3>Required environment</h3>
            <Table
              head={["Var", "Purpose"]}
              rows={[
                [<code key="e">REMIT_MASTER_KEY</code>, "32-byte hex key; encrypts agent keys + card secrets at rest"],
                [<code key="e">REMIT_ADMIN_TOKEN</code>, "Ops bearer token for the management API (server-side only)"],
                [<code key="e">REMIT_PRIVY_APP_ID</code>, "Dashboard lane: enables per-user Privy auth against the app JWKS"],
              ]}
            />
            <h3>Common optional environment</h3>
            <Table
              head={["Var", "Purpose"]}
              rows={[
                [<code key="e">REMIT_PUBLIC_MCP_BASE</code>, "Public origin for card URLs (also arms the MCP Host allowlist)"],
                [<code key="e">REMIT_CORS_ORIGINS</code>, "Comma-separated allowed origins for the API + shop"],
                [<code key="e">STRIPE_SECRET_KEY</code>, "Stripe TEST-mode key (sk_test_/rk_test_ only); enables the fiat leg"],
                [<code key="e">REMIT_STRIPE_WEBHOOK_SECRET</code>, "Real-time auth webhook secret; unset = fiat leg disabled (503)"],
                [<code key="e">REMIT_FIAT_SETTLEMENT</code>, "1 = approved Visa charges settle on-chain as real USDC"],
                [<code key="e">VENICE_API_KEY · VENICE_MODEL</code>, "Enables /cards/compile; pin the model id"],
                [<code key="e">REMIT_DASHBOARD_BASE</code>, "Dashboard origin hosting the OAuth consent page"],
              ]}
            />
            <h3>Contracts (Base mainnet · chain 8453)</h3>
            <Table
              head={["Contract", "Address"]}
              rows={[
                [<code key="c">DelegationManager</code>, <code key="v">0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3</code>],
                [<code key="c">Stateless7702 delegator impl</code>, <code key="v">0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B</code>],
                [<code key="c">USDC</code>, <code key="v">0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</code>],
              ]}
            />
          </Section>

          {/* ---- Cook Off ---- */}
          <Section id="cookoff" title="The Cook Off">
            <p className="docp">
              remit was built for the MetaMask Smart Accounts Kit × 1Shot API × Venice AI Dev Cook Off. The hard gate,
              Smart Accounts Kit in the main flow, is the product itself: every card is a SAK delegation, signed by a
              Privy-provisioned embedded smart account, and every spend redeems it on-chain.
            </p>
            <Table
              head={["Track", "What remit does"]}
              rows={[
                ["x402 + ERC-7710", "paid_fetch pays HTTP 402 through the card's 7710 delegation; real x402 v2 on Base mainnet"],
                ["Best Agent experience", "One URL is the whole integration; typed refusals; an OAuth lane for consent UX"],
                ["Agent-to-agent", "issue_subcard redelegates narrower authority; revoke + nuke kill whole subtrees in one signature"],
                ["Venice AI", "The issue modal compiles plain language into signed card terms (model names, registry resolves)"],
                ["1Shot Relayer", "Every redemption rides the 1Shot Public Relayer, gasless, fees in USDC"],
              ]}
            />
            <hr className="docrule" />
            <p className="docp">
              Ready to issue one? <Link href="/">Open the dashboard</Link>, sign in, and your first card takes about a
              minute.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
