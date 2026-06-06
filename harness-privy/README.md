# harness-privy

Minimal client-side harness that validates the one unprobed part of remit's
signing stack: the **Privy embedded wallet** as the root signer for both

1. **EIP-7702 authorization** signing (so the user's account can adopt the
   Stateless7702 delegator code), and
2. **EIP-712 ERC-7710 delegation** signing (so the user can issue a "card" via
   the Smart Accounts Kit `signDelegation`).

Everything downstream (1Shot relayer, caveats, redelegation, cascade revoke) is
already probe-proven in `../probes/`. This harness closes the last gap: does a
Privy embedded wallet produce signatures that recover to the embedded address
under both schemes.

Chain: **Base mainnet (8453)**. No funds move, no transactions are sent. The
only network calls are: Privy auth, the embedded-wallet signing RPC, and one
read-only `eth_getTransactionCount` against `https://mainnet.base.org`.

## Run

```bash
bun install
bun run dev
# open http://localhost:5173
```

Then click the four steps in order:

| Step | Button | What it proves |
| ---- | ------ | -------------- |
| 1 | **Login** | Opens the Privy login modal (email / Google). On success an embedded Ethereum wallet is auto-created (`createOnLogin: 'all-users'`). The user id and embedded wallet address render once ready. |
| 2 | **Sign 7702 auth** | Signs an EIP-7702 authorization (`useSign7702Authorization`) for `contractAddress = EIP7702StatelessDeleGatorImpl` on chain 8453. Fetches the live on-chain nonce from Base (fresh wallet = 0) and signs with it; both the default 0 and the live value are displayed. **Local assertion:** `recoverAuthorizationAddress(r,s,yParity)` must equal the embedded wallet address. Shows PASS/FAIL. |
| 3 | **Sign delegation** | Builds a ROOT ERC-7710 delegation struct directly (`{delegator: embedded, delegate: throwaway, authority: ROOT_AUTHORITY, caveats: [], salt: random}`) and signs it via SAK `smartAccount.signDelegation({delegation, chainId})` where the smart account is a `Stateless7702` account with `signer: { account: await toViemAccount(wallet) }`. **Local assertion:** `verifyTypedData` against the DelegationManager EIP-712 domain (`name: "DelegationManager"`, `version: "1"`, chainId 8453, verifyingContract `0xdb9B…7dB3`) must recover the embedded address. Shows PASS/FAIL. |
| 4 | **Export JSON** | Downloads the full structured result log as JSON, ready to paste into `../probes/RESULTS.md`. |

### Expected passing run

Two PASS assertions:

- **Step 2:** `recoverAuthorizationAddress(sig) == embedded wallet address`
- **Step 3:** `verifyTypedData(DelegationManager domain, signed delegation) == embedded address`

Build proof (tsc typecheck + production bundle, no dev server left running):

```bash
bun run build   # tsc --noEmit && vite build, exits 0
```

## What is hard-coded (all public-safe)

- Privy **App ID** + **Client ID** (`src/config.ts`) — Privy client credentials,
  public by design. The Privy **app secret** is NOT in this repo and is never
  needed client-side.
- `DELEGATION_MANAGER` `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`
  (same on Base + Base Sepolia).
- Throwaway delegate `0x5117715db9A94F66E56Cb564728615842DC07bba` (holds nothing).
- The `EIP7702StatelessDeleGatorImpl` address is read at runtime from
  `getSmartAccountsEnvironment(8453)`, never hard-coded.

No private keys exist anywhere in this harness; the embedded wallet signs
everything.

## Discrepancies vs research notes

Verified against the actually-installed packages (`@privy-io/react-auth@3.29.2`,
`@metamask/smart-accounts-kit@1.6.0`, `viem@2.52.0`):

1. **`useSign7702Authorization` return shape.** Research said the result uses
   `contractAddress` (not `address`) and `yParity` (not `v`). In the installed
   v3.29.2 the **input** uses `contractAddress`, but the **return object** uses
   viem's `SignedAuthorization` shape: `{ r, s, yParity, v?, address, chainId,
   nonce }` — i.e. it returns `address` (the contract delegated to) AND `yParity`
   (plus an optional `v`). So "`yParity` not `v`" holds (yParity is always
   present, v is optional); "`contractAddress` not `address`" is true only for
   the *input*, not the return. We recover with `recoverAuthorizationAddress`
   using `{ address: impl, chainId, nonce, r, s, yParity }`, which is the correct
   viem `Authorization` field set.

2. **`signDelegation` is a method on the smart account, not a top-level call.**
   The kit *does* export a top-level `signDelegation`, but that one requires a
   raw `privateKey` and is the wrong path here. The embedded-wallet path is
   `smartAccount.signDelegation({ delegation, chainId })`, which internally calls
   `signer.signTypedData(...)` against the DelegationManager domain. It returns
   the signature `Hex` only (the harness re-attaches it conceptually for
   verification). Confirmed from the installed `.d.ts` and runtime `index.mjs`.

3. **`toViemAccount` is async and returns a `signer:{account}`-compatible object.**
   Confirmed: `toViemAccount({ wallet })` is `Promise<...>` and the resolved
   object has `address` + `signMessage` + `signTypedData`, exactly matching the
   kit's `AccountSignerConfig = { account: Pick<Account, 'signMessage' |
   'signTypedData' | 'address'> }`.

4. **viem version drift required a pin bump, not a pin down.** The kit's peer
   range is `viem ^2.31.4`; Privy bundles `viem 2.52.0`. Pinning the app to the
   kit floor (`2.31.4`) made the bundler resolve a viem that lacks the `tempo` /
   `tempoModerato` chains that `@privy-io/js-sdk-core` imports, so the *bundle*
   failed (tsc passed). Fix: pin the app to `viem@2.52.0` — satisfies the kit's
   `^2.31.4` range AND matches Privy's bundled version, so there is a single
   viem and the `tempo` exports exist. A couple of cross-package boundary casts
   remain in `App.tsx` (`as any` on the `toMetaMaskSmartAccount` client/signer
   and on the `verifyTypedData` params) because the kit's `readonly` TypedData
   generics and `Account` pick still don't structurally unify with viem's
   mutable generics. These are type-only casts over runtime-identical objects;
   the local recover/verify assertions are the real correctness check.

5. **Embedded wallet selection.** `useWallets()` is used and the embedded wallet
   is matched by `walletClientType === 'privy' || === 'privy-v2'` (the installed
   types document both as the embedded-wallet client types).
