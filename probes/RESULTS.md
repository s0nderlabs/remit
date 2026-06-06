# 1Shot Public Relayer — caveat-composition probe results

Run: 2026-06-05 22:41 WIB. Local-only, UNFUNDED. No `send`/`relayer_send7710Transaction`
ever called. Only `relayer_getCapabilities`, `relayer_getFeeData`,
`relayer_estimate7710Transaction` (synchronous, no task, no on-chain effect).

SDK: `@metamask/smart-accounts-kit@1.6.0` + `viem@2.52.2` + `@metamask/delegation-core`
(transitive) + `@metamask/smart-accounts-kit/utils` (`createCaveatBuilder`). Runtime: bun 1.3.14.

Endpoints: `.dev` 84532 (Base Sepolia) primary; `.com` 8453 (Base mainnet) repeat with a
fresh unfunded key. Results IDENTICAL across both chains unless noted.

---

## Headline verdicts

- **PLAN A (rich programmatic-7710, multi-hop sub-cards): YES.** A 2-hop chain
  `A_user (Stateless7702) -> A_agent (BARE EOA) -> relayer targetAddress` is accepted and
  fully simulated. The bare-EOA agent works as an intermediate redelegator: its leaf
  signature is ECDSA-verified on-chain, the redelegation authority linkage is enforced, and
  the only remaining failure on an unfunded key is the ERC20 balance check. Cascade-revoke
  via `NonceEnforcer` on the root is structurally supported (the nonce caveat rides through
  to simulation). **Plan B (Hybrid/Pimlico fallback) is NOT needed to de-risk the chain.**

- **Every caveat composition we tried was ACCEPTED to on-chain simulation. ZERO 4209 /
  UnsupportedCapability rejections across the entire matrix, on both chains.** The relayer
  does not gate on caveat type or stack shape; it forwards to the DelegationManager and the
  individual enforcers decide. The picker vocabulary is therefore effectively the full SDK
  caveat catalog (subject to the deployment caveats in "Picker vocabulary" below).

- **HARD relayer constraint: `authorizationList` must contain EXACTLY ONE entry.** Two
  entries -> `"Authorization list must contain exactly one entry"`. This means a single
  relayer call can 7702-upgrade AT MOST ONE account in-bundle. For Plan A that one entry
  must be the ROOT delegator (`A_user`); the agent must be a bare EOA (leaf-only spender) or
  already-upgraded from a prior bundle.

- **Validation order (discovered):**
  1. exactly-one authorizationList entry,
  2. `permissionContext[0].delegate` must equal the relayer targetAddress (ordering = `[leaf, root, ...]`, leaf first),
  3. a fee transfer to feeCollector `>= minFee` must exist in `executions`,
  4. on-chain simulation: signatures (leaf + root), redelegation authority linkage, every enforcer, then balances.

---

## Verdict table

| Probe | Chain | What | Verdict | Raw signal (verbatim) | Implication |
|---|---|---|---|---|---|
| 0 | 84532/8453 | local env | OK | `EIP7702StatelessDeleGatorImpl=0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`, `DelegationManager=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` (same both chains) | SDK env correct, chains share addresses |
| 5 | 84532 | getCapabilities | OK | `{"84532":{"feeCollector":"0xE936...604","targetAddress":"0xf1ef...Ca9","tokens":[{USDC,6}]}}` | live constants confirmed |
| 5 | 8453 | getCapabilities | OK | `{"8453":{...,"targetAddress":"0x26a5...199a","tokens":[USDC,USDT]}}` | mainnet also supports USDT |
| 5 | 84532 | getFeeData(USDC) | OK | `rate:2000, minFee:"0.01", gasPrice:"8237708" (decimal wei str), expiry:int, context:signed-blob` | schema confirmed (see below) |
| 5 | 8453 | getFeeData(USDC) | OK | `rate:1598.04, minFee:"0.01", gasPrice:"16345475"` | rate differs per chain; same schema |
| 1 | 84532/8453 | baseline single delegation (Erc20TransferAmount, fee+pay execs, 7702 auth) | SIM (balance) | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | single delegation validates + simulates; fails only on funds |
| 2 | 84532/8453 | chain-2 Plan A, ordering `[leaf,root]`, user auth | SIM (balance) | `Error(ERC20: transfer amount exceeds balance)` | **Plan A structurally valid** |
| 2 | 84532/8453 | chain-2, ordering `[root,leaf]` | REJECT (validation) | `First delegation's delegate must be the relayer Target wallet (0x...), got 0x<agent>` | leaf MUST be `permissionContext[0]` |
| 3 | 84532 | chain-2, auth = AGENT instead of user | SIM (revert) | `CALL_EXCEPTION ... to: DelegationManager` | wrong account upgraded -> reverts at sim, not validation |
| 3 | 84532/8453 | chain-2, TWO authorizationList entries | REJECT (validation) | `Authorization list must contain exactly one entry` | **exactly-one-auth hard guard** |
| 2b | 84532 | chain-2, corrupt LEAF signature | SIM (sig) | `Gas estimation failed: ECDSAInvalidSignature()` | bare-EOA leaf sig verified on-chain |
| 2b | 84532 | chain-2, corrupt ROOT signature | SIM (sig) | `ECDSAInvalidSignature()` | root (7702) delegation sig verified |
| 2b | 84532 | chain-2, detach leaf authority from root | SIM (authority) | `InvalidAuthority()` | redelegation linkage enforced |
| 4a | 84532/8453 | erc20PeriodTransfer alone (root) | SIM (balance) | `Error(ERC20: transfer amount exceeds balance)` | accepted |
| 4b | 84532/8453 | + timestamp | SIM (balance) | same | accepted |
| 4c | 84532/8453 | + nonce (NonceEnforcer) | SIM (balance) | same | accepted (cascade-revoke primitive works) |
| 4d | 84532/8453 | + limitedCalls(1) | SIM (balance) | same | accepted |
| 4e | 84532/8453 | + allowedCalldata recipient pin (merchant lock) | SIM (balance) | same (pin to feeCollector, single exec) | accepted; see merchant-lock note |
| 4f | 84532/8453 | logicalOrWrapper (OR-group, real enforcer `0xE130...B46c`, groupIndex=0) | SIM (balance) | `Error(ERC20: transfer amount exceeds balance)` | **CORRECTED (see addendum): accepted-to-simulation YES.** Original "NOT deployed" was an SDK env-map omission, not chain reality |
| 4f-wrongGroup | 84532 | OR-group, select group 1 but pay group 0's recipient | SIM (sub-caveat reject) | `Error(AllowedCalldataEnforcer:invalid-calldata)` | wrapper routes into the selected group and runs its sub-enforcer |
| 4f-badGroupIndex | 84532 | OR-group, groupIndex 5 (out of range) | SIM (wrapper reject) | `Error(LogicalOrWrapperEnforcer:invalid-group-index)` | wrapper bounds-check live |
| 4f-badArgsLen | 84532 | OR-group, caveatArgs len 2 vs 1 caveat | SIM (wrapper reject) | `Error(LogicalOrWrapperEnforcer:invalid-caveat-args-length)` | wrapper args-length check live |
| 4g | 84532/8453 | FunctionCall leaf (allowedTargets+allowedMethods, approve work-call) | SIM (balance) | same | accepted |
| 4h | 84532/8453 | swap-ish (allowedTargets router + allowedMethods + erc20BalanceChange guard) | SIM (balance) | same | accepted |
| 4i | 84532/8453 | exactCalldata leaf | SIM (balance) | same | accepted |
| 6 | 84532 | omit fee execution | REJECT (payment) | `No valid payments to the feeAddress were found in the transaction calldata.` | fee transfer is mandatory, checked pre-sim |
| 6 | 84532 | fee < minFee | REJECT (payment) | `Mock payment must be at least the chain minimum fee (10000 smallest units for this token).` | minFee=0.01 USDC = 10000 atoms; checked pre-sim |
| 6 | 84532 | fee == minFee | SIM (balance) | `Error(ERC20: transfer amount exceeds balance)` | fee path satisfied |

"SIM (X)" = request passed all relayer validation and reached on-chain `eth_estimateGas`
simulation, failing at stage X. None of these are caveat rejections; on a funded account
they would proceed. "REJECT" = relayer-level validation rejection (NOT a caveat-type gate).

---

## Picker vocabulary verdict (which compositions ship)

All of the following were accepted-to-simulation and are SAFE to expose in the card picker
on Base + Base Sepolia via the 1Shot relayer:

- **Spend cap (recurring):** `erc20PeriodTransfer` (periodAmount / periodDuration / startDate).
  NOTE: `startDate` must be `<= block.timestamp` or the enforcer reverts
  `ERC20PeriodTransferEnforcer:transfer-not-started`. Set startDate a few seconds in the past.
- **Spend cap (one-shot total):** `erc20TransferAmount` (maxAmount) — also the natural LEAF scope.
- **Expiry window:** `timestamp` (afterThreshold / beforeThreshold).
- **Cascade-revoke primitive:** `nonce` (NonceEnforcer) — root nonce caveat redeems through
  the chain; bumping it kills the whole sub-card tree. This is the demo money-shot and it works.
- **Call budget:** `limitedCalls(n)`.
- **Merchant / recipient lock:** `allowedCalldata` (pin recipient word at startIndex 4 of an
  ERC20 transfer). CAVEAT: AllowedCalldataEnforcer applies to EVERY governed execution, and
  the mandatory fee transfer goes to feeCollector. So a recipient pin on the ROOT collides
  with the fee leg. Put the recipient pin on the LEAF that only governs the payment execution,
  or keep the fee execution out of the pinned delegation's scope.
- **Target / method whitelist (approvals, swaps):** `allowedTargets` + `allowedMethods`
  (FunctionCall scope). Selectors accept `0x`-hex, string sig, or AbiFunction.
- **Balance-delta guard:** `erc20BalanceChange` (Increase/Decrease, recipient, balance).
- **Exact-calldata pin:** `exactCalldata` (per execution) / `exactCalldataBatch` (per batch).

- **OR-group caveats (`logicalOrWrapper`): YES, usable** — see CORRECTED addendum below.
  Original "not expressible" was WRONG (SDK env-map omission, not chain reality). The
  enforcer is live at `0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c` on both chains and the
  relayer simulates it correctly. Wire it manually (the SDK env map doesn't list it).

---

## getFeeData schema (confirmed; docs drift)

```
result: {
  chainId: "84532",                 // decimal string
  token: { decimals: 6, address, symbol, name },
  rate: 2000,                       // number (testnet 2000, mainnet ~1598)
  minFee: "0.01",                   // DOLLAR-DECIMAL string -> 10000 atoms at 6 dec
  expiry: 1780674055,               // unix int
  gasPrice: "8237708",              // DECIMAL WEI string (NOT hex, despite docs)
  feeCollector, targetAddress,
  context: "{...signed blob...}"    // pass-through; base64 signature inside
}
```
`relayer_getFeeData` params = bare object `{chainId: "<decimal>", token: "0x..."}`.
`relayer_getCapabilities` params = FLAT array of decimal chainId strings, e.g. `["84532"]`.

---

## SDK type findings (PROBE FINDING #3 — signer shape)

- **`signer: { account }` is type-valid AND works at runtime** for
  `toMetaMaskSmartAccount({ implementation: Implementation.Stateless7702, address, signer: { account } })`.
  The `AccountSignerConfig = { account: Pick<Account,'signMessage'|'signTypedData'|'address'> }`
  shape is accepted; the `walletClient` wrapper is NOT required. Use `signer: { account }`.
- **The ONE type friction is the `client` field, not the signer.** `tsc --strict` emits
  TS2719 "Two different types with this name exist (PublicClient)" on the `client:` field.
  Cause: the kit's bundled `.d.ts` references viem types built against an earlier viem
  (peerDep `^2.31.4`); against the installed `viem@2.52.2` the structural `PublicClient`
  (deep `getBlock` transaction union) no longer matches by identity. Casting `client` to
  `any` (or pinning viem nearer the kit's build) clears it. Runtime is unaffected. There is
  only ONE physical viem copy in node_modules (2.52.2), so this is a type-bundling drift, not
  a dependency dupe.
- **`createDelegation` requires one of `scope` / `parentDelegation` / `parentPermissionContext`**
  even when you pass an explicit `caveats[]` (it uses that field to set `authority`). To build
  a ROOT delegation with an exact custom caveat set and no extra scope caveat, construct the
  `Delegation` struct directly with `authority: ROOT_AUTHORITY` (as done in probe2/probe4).
- **Caveat builders are NOT top-level exports.** Individual `*Builder` functions live inside
  the kit; use `createCaveatBuilder(env)` from `@metamask/smart-accounts-kit/utils` (fluent
  `.addCaveat(name, config).build()`), or `createCaveat(enforcer, terms, args?)` +
  `@metamask/delegation-core` term encoders (`createERC20TokenPeriodTransferTerms`,
  `createTimestampTerms`, `createNonceTerms`, etc.) for raw control.
- **Top-level `signDelegation`** (for bare-EOA leaf signing) =
  `signDelegation({ privateKey, delegation, delegationManager, chainId })`. The smart account
  instance also exposes `.signDelegation({ delegation, chainId })` for the 7702 delegator.
- Running from `/tmp` breaks module resolution (can't see the project node_modules). Keep all
  probe files inside `probes/`.

---

## Wire-format notes (for the build harness)

- `permissionContext` = ARRAY of delegation OBJECTS (`{delegate, delegator, authority,
  caveats:[{enforcer,terms,args}], salt, signature}`), leaf first. NOT an encoded hex blob.
  Salt is already a 0x-hex string from the SDK; all struct fields are hex.
- `executions` = `[{target, value: "0", data}]`. Fee transfer to feeCollector FIRST.
- `authorizationList` entry = `{chainId:"0x..", address:<impl>, nonce:"0x..", yParity:"0x..", r, s}`.
  EXACTLY ONE entry. address = `EIP7702StatelessDeleGatorImpl`.
- estimate params = `{chainId:"<decimal>", transactions:[{permissionContext, executions}], authorizationList?}`.
- estimate failures come back as `result.success:false` with an `error` STRING (not a
  JSON-RPC error object). Record the string. (We never observed numeric 4209/4201/etc codes
  from estimate; the relayer returns human-readable strings here.)

---

## Funding gap (probe row 6 clean success)

Circle faucet (`https://faucet.circle.com`) is a Next.js SPA behind a captcha; the public
API (`api.circle.com/v1/faucet/drips`) requires a Bearer API key (401 without). Programmatic
funding was NOT feasible without a browser session or key, so the suite ran UNFUNDED. The
"caveat rejected vs reached-simulation" discrimination (the actual de-risking goal) is fully
established without funds: every composition reaches simulation and fails only on balance.

The ONE shape we could not capture is a funded `success:true` estimate with `requiredPaymentAmount`
+ returned context. To capture it later: fund a throwaway Stateless7702 account with a few
test USDC on Base Sepolia, then re-run `probe1-baseline.ts` / `probe2-chain2.ts` (still
estimate-only, NEVER send).

---

## File map (reusable harness seed)

- `lib.ts` — shared harness: chain constants, throwaway keys, Stateless7702 builder,
  `createCaveatBuilder` helper, wire formatting, executions, 7702 auth signing, relayer
  JSON-RPC client (`getCapabilities`/`getFeeData`/`estimate`).
- `index.ts` — runs the full suite (`bun run index.ts [chainId]`).
- `probe5-capabilities-fees.ts` — probe 0 (env) + probe 5 (capabilities/fees) both chains.
- `probe1-baseline.ts` — probe 1 baseline single delegation.
- `probe2-chain2.ts` — probe 2/3 chain-2 Plan A + ordering + auth variants.
- `probe2b-ordering-validation.ts` — probe 2b validation-order discrimination (corrupt one factor).
- `probe4-caveat-matrix.ts` — probe 4 full caveat stack matrix (rows 4a-4i; row 4f corrected).
- `probe4f-orwrapper.ts` — focused OR-wrapper live-enforcement discrimination (ok / wrongGroup / badGroupIndex / badArgsLen + mainnet).
- `probe6-fee-requirement.ts` — fee-execution requirement + sub-minFee discrimination.
- `probe-mainnet.ts` — repeat of key rows on 8453.

---

## ADDENDUM (2026-06-05, follow-up) — row 4f CORRECTED: OR-groups ARE usable

The original row 4f finding ("LogicalOrWrapperEnforcer NOT deployed") was WRONG. It reflected
an omission in SAK 1.6.0's `getSmartAccountsEnvironment().caveatEnforcers` map, not on-chain
reality. The enforcer IS live (delegation-framework v1.3.0, CREATE2-deterministic) at the SAME
address on both chains:

```
LogicalOrWrapperEnforcer = 0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c
```
Verified `eth_getCode` => 3836 bytes on Base Sepolia (84532) AND Base mainnet (8453).

**Verdict: accepted-to-simulation = YES, both chains.** A root delegation carrying an
OR-group caveat (manually wired with the address above) redeems through the 1Shot relayer and
reaches on-chain simulation; the only failure on an unfunded key is the ERC20 balance check.
Live enforcement is proven by the discrimination variants (the wrapper's own and sub-enforcer
error strings, all from the framework source, fire exactly as expected):

| variant | redeem | result |
|---|---|---|
| ok | groupIndex 0, recipient == feeCollector (group 0's pin) | `ERC20: transfer amount exceeds balance` (wrapper passed) |
| wrongGroup | groupIndex 1 (merchant pin) but recipient is feeCollector | `AllowedCalldataEnforcer:invalid-calldata` |
| badGroupIndex | groupIndex 5 (out of range) | `LogicalOrWrapperEnforcer:invalid-group-index` |
| badArgsLen | groupIndex 0, caveatArgs length 2 vs 1 caveat | `LogicalOrWrapperEnforcer:invalid-caveat-args-length` |

### Terms/args ABI (from framework source `LogicalOrWrapperEnforcer.sol` + `Types.sol`)

- **terms** (the caveat's `terms` field, static) = `abi.encode(CaveatGroup[])` where
  `CaveatGroup { Caveat[] caveats }` and `Caveat { address enforcer; bytes terms; bytes args; }`.
  Each group is an AND-set of sub-caveats; groups are the OR alternatives. The inner
  `Caveat.args` is IGNORED by the enforcer (it uses the per-redemption `caveatArgs` instead), so
  set inner args to empty / `0x00`.
- **args** (the caveat's `args` field, supplied PER REDEMPTION) = `abi.encode(SelectedGroup)`
  where `SelectedGroup { uint256 groupIndex; bytes[] caveatArgs; }`. `groupIndex` picks which
  group to evaluate; `caveatArgs.length` MUST equal the number of caveats in that group (use
  empty bytes for sub-caveats needing no per-redemption args, e.g. AllowedCalldata).
- The wrapper's `beforeHook` is `onlyDefaultExecutionMode`; the AllowedCalldata sub-enforcer is
  `onlySingleCallTypeMode`, so wrap single-call-mode sub-caveats and redeem a SINGLE execution
  (we used one fee transfer to feeCollector with group 0 pinned to feeCollector).

### Exact encoding that worked (verbatim, Base Sepolia, recipient = feeCollector)

`delegation-core` encoders produce byte-identical output to raw `viem.encodeAbiParameters`
over the `CaveatGroup[]` / `SelectedGroup` tuples (verified). Build it with:

```ts
import { createLogicalOrWrapperTerms, createLogicalOrWrapperArgs,
         createAllowedCalldataTerms } from "@metamask/delegation-core";
import { createCaveat } from "@metamask/smart-accounts-kit";
import { pad } from "viem";

const AC = env.caveatEnforcers.AllowedCalldataEnforcer; // 0xc2b0d624...0f55 (84532)
const acTerms = (addr) => createAllowedCalldataTerms({ startIndex: 4, value: pad(addr, { size: 32 }) });

const terms = createLogicalOrWrapperTerms({ caveatGroups: [
  [{ enforcer: AC, terms: acTerms(FEE_COLLECTOR), args: "0x00" }], // group 0
  [{ enforcer: AC, terms: acTerms(MERCHANT),      args: "0x00" }], // group 1
]});
const args  = createLogicalOrWrapperArgs({ groupIndex: 0n, caveatArgs: ["0x00"] });
const orCaveat = createCaveat("0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c", terms, args);
```

Resulting caveat (the one that reached simulation):
- `enforcer` = `0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c`
- `terms` (768 bytes) = `abi.encode(CaveatGroup[])` — two groups, each one AllowedCalldata
  caveat. group 0 sub-terms = `createAllowedCalldataTerms({startIndex:4, value: pad(feeCollector,32)})`
  = `0x...0004` `||` `0x000...feeCollector`(32) ; group 1 = same with the merchant address.
- `args` = `createLogicalOrWrapperArgs({ groupIndex: 0n, caveatArgs: ["0x00"] })`
  = `0x` + uint256 groupIndex(0) + offset(0x40) + bytes[] len(1) + offset(0x20) + bytes len(1) + `00`-padded.

NOTE: `delegation-core`'s caveat-tuple normalizer REJECTS `"0x"` for the inner `args` field
(`isHexString("0x") === false`); use `"0x00"` (the enforcer ignores it anyway). If you need
truly-empty inner args, encode the `CaveatGroup[]` with raw `viem.encodeAbiParameters` instead
(byte-identical structure, accepts `"0x"`).

### Picker-vocabulary impact

OR-groups SHIP. This unlocks "spend at merchant A OR merchant B" / "approve router X OR
router Y" cards in one delegation, with the redeemer choosing the branch at execution time via
`groupIndex`. Remember the security note from the enforcer source: the redeemer picks the
LEAST restrictive group, so every group must be independently safe.

---

## Phase A validation probes (Jun 5 2026, late night)

Three follow-up probes feeding the go/no-go lock. Same harness, same estimate-only
discipline (NEVER `send`), throwaway unfunded keys. Run 2026-06-05 ~23:30 WIB. Every row run
on BOTH chains; results IDENTICAL across 84532 and 8453 unless noted. No rate-limiting,
quote-expiry, or flakiness observed (all `http=200`, all deterministic on repeat).

Files: `probe7-chain3.ts`, `probe8-exec-modes.ts`, `probe9-root-total.ts` (wired into `index.ts`).

### Probe 7 — chain-length-3 permissionContext (deeper sub-card tree)

Composition: `A_user (Stateless7702 root: erc20PeriodTransfer + timestamp + nonce)` ->
`A_agent1 (BARE EOA, attenuated erc20TransferAmount)` -> `A_agent2 (BARE EOA, leaf
Erc20TransferAmount -> relayer targetAddress)`. Both agents bare EOAs.
`authorizationList = [A_user 7702 auth]` ONLY. `permissionContext = [leaf, child, root]` (LEAF-FIRST).
Executions: fee transfer to feeCollector + work transfer to a merchant.

| Probe | Chain | Composition | Expected | Actual (verbatim) | Verdict |
|---|---|---|---|---|---|
| 7-ok | 84532 | 3-hop chain, all links valid | accepted-to-sim | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | **PROVEN** — full 3-hop chain validates end-to-end; only unfunded balance fails |
| 7-ok | 8453 | same | accepted-to-sim | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | **PROVEN** (mainnet) |
| 7-corruptMiddle | 84532 | MIDDLE (child) delegation signature corrupted | sig-named failure | `Gas estimation failed: ECDSAInvalidSignature()` | **PROVEN** — the middle link is actually verified on-chain (not just leaf+root) |
| 7-corruptMiddle | 8453 | same | sig-named failure | `Gas estimation failed: ECDSAInvalidSignature()` | **PROVEN** (mainnet) |

**Verdict: chain depth 3 works.** A bare-EOA -> bare-EOA -> leaf redelegation tree is fully
validated by the relayer/DelegationManager with a SINGLE 7702 auth (the root delegator).
The middle-link corruption proves every link's ECDSA signature is checked, so the
sub-card-of-a-sub-card pattern (and by induction deeper trees) is structurally sound. Cascade
revoke via the root nonce rides through unchanged (nonce caveat is on the root, present in all
ok runs that reached simulation). Depth is not a constraint for the demo's sub-card tree.

### Probe 8 — execution-count vs redemption-mode mapping (THE flagged build risk)

Setup: chain-2 Plan A, root carries `erc20PeriodTransfer` + a recipient pin (plain
`AllowedCalldataEnforcer` on transfer() recipient word, or an `LogicalOrWrapper` of two pins).
`MERCHANT = 0xc299...43ed` (fixed). `feeCollector = 0xE936...604`. Pin "value" = the 32-byte
recipient the transfer() must target.

| Probe | Chain | Composition | Expected (hypothesis) | Actual (verbatim) | Verdict |
|---|---|---|---|---|---|
| 8a | 84532/8453 | plain pin=MERCHANT, execs=[fee->feeCollector, work->MERCHANT] | mode-error if batch; pin-fail-on-fee if per-exec | `Gas estimation failed: Error(AllowedCalldataEnforcer:invalid-calldata)` | pin checked the FEE leg (slot 0) and failed (feeCollector != MERCHANT) |
| 8b | 84532/8453 | OR-wrapper{g0=feeCollector,g1=MERCHANT}, select g1, execs=[fee->feeCollector, work->MERCHANT] | one args blob, one group selected | `Gas estimation failed: Error(AllowedCalldataEnforcer:invalid-calldata)` | g1 (MERCHANT) checked against the FEE leg (slot 0) and failed; one args blob => one group for the whole request |
| 8c | 84532/8453 | plain pin=feeCollector, SINGLE exec=[fee->feeCollector] (baseline) | accepted-to-sim | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | **baseline OK** — single satisfied-pin execution reaches sim |
| 8d | 84532/8453 | plain pin=MERCHANT, SINGLE exec=[work->MERCHANT], NO fee | reject for missing fee, OR accept | `No valid payments to the feeAddress were found in the transaction calldata.` | **fee is MANDATORY pre-sim**; cannot omit it even with a single work exec |
| 8e | 84532/8453 | plain pin=feeCollector, execs=[fee->feeCollector, work->MERCHANT] | discriminator | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | pin satisfied by slot 0 (fee); work->MERCHANT in slot 1 was NOT checked -> reached balance |
| 8f | 84532/8453 | plain pin=MERCHANT, execs=[work->MERCHANT, fee->feeCollector] (ORDER FLIPPED) | discriminator | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | pin satisfied by slot 0 (work->MERCHANT); fee in slot 1 was NOT checked -> reached balance |
| 8g | 84532/8453 | plain pin=feeCollector, THREE execs=[fee->feeCollector, work, work2] | discriminator | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | only slot 0 pin-checked; 3 execs accepted; no batch-mode error |

**The redemption-mode model (PROVEN by 8a/8e/8f/8g together):** the relayer does NOT batch the
executions into one BATCH-mode redemption. A `onlySingleCallTypeMode` enforcer
(`AllowedCalldataEnforcer`) NEVER threw a mode/call-type error, even with 2 (8a,8e,8f) and 3
(8g) executions present. Instead the executions are mapped to **per-execution single-default
redemptions**, and the root `AllowedCalldata` pin is **consumed positionally against
execution[0] only** — proven by the order-flip: pin=MERCHANT fails when the fee is slot 0 (8a)
but PASSES when work->MERCHANT is slot 0 and the fee rides slot 1 unchecked (8f); symmetrically
pin=feeCollector passes when fee is slot 0 regardless of what slots 1..n do (8e, 8g).

HONEST LIMITATION (estimate-only): two internal models are observationally identical from the
outside and I cannot separate them without a funded `send` (which we never do): (a) ONE
redemption whose batch is decoded but whose single-call AllowedCalldata inspects only call[0];
(b) N per-execution redemptions where the root caveat's positional arg is consumed by only the
first. Both predict every row above. The BUILD-RELEVANT fact is identical under either model and
is fully proven: **a root recipient-pin (plain or OR-wrapped) governs ONLY the first execution;
later executions are NOT subject to it.**

**Probe-8 deliverable statement:** multi-merchant (OR-wrapped or plain calldata-pinned) cards
**CAN** pay fee+work in one request. The fee transfer to feeCollector is mandatory pre-sim and
cannot be omitted (8d), and the OR-wrapper resolves to a SINGLE selected group per request (one
`groupIndex` args blob governs the whole request, not per-execution — 8b). Because the root pin
only governs execution[0], the workaround is **execution ordering**: put the PINNED/work
execution in slot 0 (so the recipient pin or the selected OR-group validates the merchant leg)
and let the mandatory fee transfer ride a LATER, unchecked slot. Equivalently, keep the
merchant pin OFF the root and put it on a LEAF that governs only the work execution (the
existing probe-4 guidance still holds). What you CANNOT do in one request: enforce DIFFERENT
per-execution recipient pins via a single OR-wrapper args blob (only one group is selected per
request), and you cannot make the root pin simultaneously constrain both the work leg AND the
fee leg. For a true multi-merchant card paying several distinct merchants atomically with
per-leg recipient locks, use one delegation per merchant leg (separate redemptions) or push the
locks to per-leg leaves rather than a single root pin.

### Probe 9 — ERC20TransferAmountEnforcer as a ROOT caveat (lifetime-total card)

| Probe | Chain | Composition | Expected | Actual (verbatim) | Verdict |
|---|---|---|---|---|---|
| 9-total | 84532/8453 | root = erc20TransferAmount(USDC,100) + timestamp + nonce; leaf = Erc20TransferAmount | accepted-to-sim | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | **PROVEN** — lifetime-total cap works as a root caveat |
| 9-stacked | 84532/8453 | root = erc20PeriodTransfer + erc20TransferAmount + timestamp + nonce | accepted-to-sim | `Gas estimation failed: Error(ERC20: transfer amount exceeds balance)` | **PROVEN** — rolling-window cap AND lifetime ceiling compose in one root |

**Verdict: lifetime-total cards SHIP, and period + lifetime compose.** `erc20TransferAmount`
(builder config `{tokenAddress, maxAmount}`) is usable not only as the leaf scope but as a root
caveat enforcing a cumulative lifetime ceiling on the whole sub-card tree. Stacking it with
`erc20PeriodTransfer` gives "max $50/week AND max $100 ever" in a single root, both reaching
simulation. Picker gains a distinct "total budget" card type alongside the recurring "spend cap".

### Phase A verdict summary

| Probe | Chain(s) | Verdict | One-line meaning |
|---|---|---|---|
| 7 (depth-3) | 84532 + 8453 | PROVEN | 3-hop bare-EOA redelegation tree validates end-to-end; every link's sig checked |
| 8 (exec-modes) | 84532 + 8453 | PROVEN (1 honest limitation) | per-execution single-default redemption, root pin governs execution[0] only; fee mandatory; OR selects one group/request |
| 9 (root-total) | 84532 + 8453 | PROVEN | erc20TransferAmount as a root lifetime cap works and composes with the period cap |

## Phase C: Privy signing stack (Jun 6 2026 ~00:07 WIB, LIVE run, harness-privy/)

Real Privy embedded wallet (app cmq14zjut00040cjv4fgj82vd, user did:privy:cmq161bt400170cjsyelq8vt4, embedded EOA 0xbA89b92E4BE9dA380cf1b40842d4564cb8CF4442), email-OTP login, silent signing (showWalletUIs:false), Base 8453.

| Step | What | Verdict |
|---|---|---|
| 1 | Login + auto-created embedded EVM wallet | PASS (wallet created on login, walletClientType "privy") |
| 2 | EIP-7702 authorization via useSign7702Authorization (contract = EIP7702StatelessDeleGatorImpl 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B from getSmartAccountsEnvironment(8453), nonce 0 = live nonce) | PASS: recoverAuthorizationAddress == embedded address. Silent, no modal. |
| 3 | ERC-7710 ROOT delegation EIP-712 via smartAccount.signDelegation (domain {DelegationManager, 1, 8453, 0xdb9B...7dB3}) | PASS after two shims (below): all recovery variants (bigint salt / string salt / env-resolved manager / raw v4) == embedded address |

### TWO CRITICAL FINDINGS (the real remit dashboard MUST ship both shims)

1. **BigInt cannot cross Privy's iframe RPC.** The kit's toDelegationStruct makes salt a uint256 bigint; Privy's signTypedData JSON-serializes -> "TypeError: Do not know how to serialize a BigInt". Shim: deep-convert bigint -> decimal string before signing (EIP-712 v4 digest identical).
2. **toViemAccount().signTypedData is BROKEN in @privy-io/react-auth 3.29.2: signs with a random ephemeral key** (different recovered address every run: 0x380eb8c7..., 0x9D5bcCa6...), while signMessage from the SAME account object signs correctly with the embedded key. Workaround (proven): implement signTypedData over wallet.getEthereumProvider() eth_signTypedData_v4 (recovered == embedded every time). Isolation evidence: variant E (signMessage) PASS, F (raw provider v4) PASS, A/B/C (toViemAccount signTypedData) consistent-but-wrong address.

Step-2 payload (evidence): {r: 0xe3373a3d..., s: 0x29f8d6c2..., yParity: 1, v: 28, address: 0x63c0c19a... (the CONTRACT, per viem SignedAuthorization shape), chainId: 8453, nonce: 0} -> recovered 0xbA89b92E... == embedded.
Step-3 payload (evidence): delegation {delegator 0xbA89b92E..., delegate 0x5117715d... (probe throwaway), authority ROOT_AUTHORITY, caveats [], salt 0x1b27fd38...}, signature 0x7a07d732...2b0b1c, verified: true.

Phase C verdict: **Privy lane fully validated for both signature types remit needs.** Remaining funded items (Phase B) are relayer-side, not signer-side.

---

## Phase B: FUNDED MAINNET SENDS (Jun 6 2026)

The FIRST REAL `relayer_send7710Transaction` calls on Base **mainnet (8453)** through the
1Shot Public Relayer (`relayer.1shotapi.com`). Funded throwaway `A_user` =
`0x5117715db9A94F66E56Cb564728615842DC07bba` (started 0.939609 USDC, ZERO ETH by design).
MERCHANT / AGENT1 / AGENT2 = fresh locally-generated keys (held in `.env.phaseb`, chmod 600;
funds recoverable). Discipline: estimate FIRST (read-only), send IMMEDIATELY (context ~45s).
Fee = exactly minFee = `requiredPaymentAmount` = 10000 atoms = 0.01 USDC per send.

Harness: `phaseb-lib.ts` (adds `send()` + status polling + funded-account loading) and
`phaseb.ts` (composition builders + estimate-then-send driver). Loaded via
`set -a; source .env.funded; source .env.phaseb; set +a; bun run phaseb.ts <step>`.

### The estimate->send protocol (NEW, vs the estimate-only model)

1. `relayer_estimate7710Transaction` success shape (funded): `{success:true,
   paymentTokenAddress, paymentChain:8453, gasUsed:{"8453":"..."}, requiredPaymentAmount:"10000",
   context:"{...signed blob...}", contextByChainId:{"8453":"..."}}`. The `context` is a JSON
   STRING (chain/expiresAt/gasPrice/minFee/rate/signature/tokenAddress/tokenDecimals); `expiresAt`
   is ~45s out. **This closes the funding gap flagged in the original RESULTS.**
2. `relayer_send7710Transaction` params = `{chainId:"8453", transactions:[{permissionContext,
   executions}], authorizationList?, context}` where `context` = the estimate's `context` STRING
   passed back verbatim. Returns `result` = a **REQUEST ID** (0x-hex), NOT the on-chain tx hash.
3. **Inclusion is async + the request-id is NOT a chain tx hash.** `eth_getTransaction(reqId)`
   returns not-found forever. Poll `relayer_getStatus({chainId:"8453", id:reqId})` (note: the
   param key is `id`; `transactionId`/`hash` both throw `hex2.startsWith` TypeErrors server-side)
   -> `result.receipt.transactionHash` + `result.status:200`. THEN confirm that tx hash on-chain.
   The status `receipt` also carries the full decoded `RedeemedDelegation` event log array
   (relayer-target -> agent -> A_user root, with the caveat tuples inline) before block inclusion
   (blockNumber null until mined).

### Send-by-send results

| # | Composition | Request id / on-chain tx | On-chain verification | Verdict |
|---|---|---|---|---|
| EST (step1) | chain-2 funded estimate (A_user 7702 root: erc20PeriodTransfer+timestamp+nonce -> A_agent1 bare-EOA leaf), execs [fee 0.01 -> feeCollector, work 0.01 -> MERCHANT], auth=[A_user 7702 live-nonce 0] | n/a (read-only) | `success:true`, `requiredPaymentAmount:"10000"`, context+contextByChainId present | **PROVEN** (funding gap closed) |
| 1 | same chain-2 composition, SENT WITH authorizationList | reqId `0x8e04bf38...9c741` -> tx **`0x41d5550de49192cf18a123ebe69c643546c627eb0abd8ba63aa4eb91069f6b9a`** | status **success**, block 46945181, gasUsed 629362. A_user code=`0xef010063c0...32b` (7702 landed IN-bundle, delegates to EIP7702StatelessDeleGatorImpl), txCount 0->1. Balances: MERCHANT +0.01, feeCollector +0.01, A_user -0.02. | **PROVEN** (the milestone) |
| 2 | chain-3 A2A: A_user(7702 root) -> A_agent1(bare EOA middle) -> A_agent2(bare EOA leaf) -> target. execs [fee, work 0.01 -> MERCHANT]. **NO authorizationList** (A_user already coded). | reqId `0x5d3e1092...c9fdb6` -> tx **`0x575d42217e15186bf1d02aba9b3cfee44d89472a6582973e0fb620a5f356786b`** | status **success**, block 46945290, gasUsed 745620. Balances: MERCHANT 0.01->0.02, feeCollector +0.01, A_user -0.02. | **PROVEN** — bare-EOA intermediate redelegation works in a REAL send (chain-2 was estimate-proven; this is the live A2A / sub-card cascade proof). Also proves an already-7702-coded account needs NO authorizationList. |
| 3 | OR-group on root: `erc20PeriodTransfer` + `LogicalOrWrapper{g0=AllowedCalldata(feeCollector), g1=AllowedCalldata(MERCHANT)}`, args select g0, leaf `Erc20TransferAmount`, SINGLE fee execution. No auth. | reqId `0x4c90d167...27edf1` -> tx **`0x7f498c64564b1bf37375d60768f1b3d185423c62082c21fbf9ecb1139bd1a5ff`** | status **success**, block 46945413, gasUsed 446236. feeCollector +0.01, A_user -0.01. | **PROVEN** — LogicalOrWrapperEnforcer (`0xE1302607...B46c`) routes into the selected group and its AllowedCalldata sub-enforcer validates the recipient, LIVE on a funded redemption. Multi-merchant-card primitive proven. |
| 4 | swap: leaf FunctionCall scope (allowedTargets [USDC, SwapRouter02], allowedMethods [transfer, approve, exactInputSingle]), execs [fee, approve(router,0.05), exactInputSingle(USDC->WETH 500, recipient A_user, 0.05, minOut 0)] | n/a | estimate rejected TWICE | **SKIPPED** (per two-reject rule) |

### SEND #3 OR-group: LIVE behavior DIFFERS from probe-8's estimate-only model (important)

Probe-8 (estimate-only) concluded "root pin governs execution[0] only; put the pinned work in
slot 0, fee rides a later unchecked slot." On a FUNDED mainnet redemption this does NOT hold for
a root OR-wrapper with TWO executions. Estimate-discrimination on mainnet:

| variant | composition | result |
|---|---|---|
| A | g0=MERCHANT pin, select g0, execs [work->MERCHANT (slot0), fee (slot1)] | `AllowedCalldataEnforcer:invalid-calldata` (FAIL) |
| B | g0=feeCollector pin, select g0, execs [fee (slot0), work->MERCHANT (slot1)] | `AllowedCalldataEnforcer:invalid-calldata` (FAIL) |
| C | g0=MERCHANT pin, select g0, execs [work->MERCHANT] only | `No valid payments to the feeAddress were found` (fee mandatory, matches probe-8d) |
| D | g0=feeCollector pin, select g0, execs [fee] only | `success:true` -> the shape we SENT |

So: with a root OR-wrapper + the mandatory fee leg present, the relayer evaluates the selected
group against the FEE execution, and only the single-fee-execution shape with the selected group
pinned to feeCollector passes. The probe-8 "slot-0 positional" model was the honest-limitation
estimate artifact; the live mapping puts the root caveat on the fee leg. **Build consequence
(reaffirms probe-4 guidance): put merchant/recipient pins on a LEAF that governs ONLY the work
execution, NOT on the root** — a root pin collides with the mandatory fee transfer. The OR-wrapper
itself is fully live and correct (SEND #3 PROVEN); it's the root-vs-fee-leg interaction that the
estimate-only model mispredicted.

### SEND #4 swap: SKIPPED (two estimate rejections, both structural)

1. First estimate: `AllowedMethodsEnforcer:method-not-allowed`. The FunctionCall leaf scope
   `allowedMethods=[approve, exactInputSingle]` rejects the mandatory fee leg, which is an ERC20
   `transfer`. Fix attempted: add `transfer` to allowedMethods.
2. Second estimate: `ERC20PeriodTransferEnforcer:invalid-method`. The ROOT `erc20PeriodTransfer`
   cap requires every governed call to be a token `transfer`; the swap legs (`approve`,
   `exactInputSingle`) are not transfers, so the period enforcer rejects them.

Root cause is architectural, not a wiring bug: **a transfer-shaped spend cap (`erc20PeriodTransfer`)
on the root is incompatible with a swap card.** A swap card must scope the root with
allowedTargets/allowedMethods (or a non-transfer-shaped budget caveat), not a period-transfer cap.
Honoring the two-reject SKIP rule; this is a stretch goal, not a gate, and the finding (swap cards
need a different root caveat family) is the useful deliverable.

### Final accounting (USDC, Base mainnet)

| Address | Start | End | Delta | Notes |
|---|---|---|---|---|
| A_user `0x5117...7bba` | 0.939609 | 0.889609 | **-0.050000** | 3 fees (0.03) + 2 work (0.02). Now 7702-coded, txCount 1. |
| MERCHANT `0xAc36...4127` | 0 | 0.020000 | **+0.020000** | 2x 0.01 work transfers. RECOVERABLE (we hold the key). |
| feeCollector `0xE936...7604` | 7.24 | 7.27 | **+0.030000** | 3 relayer fees @ 0.01 each. |
| AGENT1 `0xa63F...6dD7` | 0 | 0 | 0 | bare-EOA redelegator, never holds funds. |
| AGENT2 `0xc2b4...373b` | 0 | 0 | 0 | bare-EOA leaf redelegator, never holds funds. |

- **Total relayer fees paid: 0.030000 USDC** (3 sends @ minFee).
- **Total UNRECOVERABLE burn: 0.030000 USDC** (the fees; MERCHANT's 0.02 is recoverable). Well
  under the 0.30 cap. Each work transfer was 0.01 (<= 0.05 cap). A_user never received ETH.
- 4 relayer sends authorized; 3 executed (all `status:success` on-chain), 1 skipped (swap, two
  estimate rejects). Zero failed sends. Zero ETH spent by us (relayer is gasless; A_user paid only
  USDC fee).

### Relayer behaviors that differ from the estimate-only model (summary)

1. `send` returns a **request id**, not a tx hash. Resolve the real tx hash via
   `relayer_getStatus({chainId, id})` -> `receipt.transactionHash`. The id is never a chain object.
2. `relayer_getStatus` param key MUST be `id` (decimal-string `chainId`). `transactionId`/`hash`
   keys throw a server-side `hex2.startsWith` TypeError.
3. Status `receipt` carries the decoded `RedeemedDelegation` event array (full caveat tuples)
   with `blockNumber:null` BEFORE inclusion; `transactionHash` is populated immediately, mined
   ~1-2 blocks later. `status:200` = accepted/included.
4. Context expiry held (~45s `expiresAt`); estimate-then-send back-to-back in one process never
   hit an expiry. No rate-limiting observed across the whole phase (all `http=200`).
5. 7702 upgrade lands IN-bundle (verified: A_user had no code pre-SEND#1, `0xef0100`+impl after).
   Subsequent sends correctly need NO authorizationList (SEND #2/#3 ran auth-less and succeeded).
6. Root OR-wrapper / AllowedCalldata pins map to the FEE execution on a real multi-execution send
   (see SEND #3 section) — the estimate-only positional model mispredicted this.

Phase B verdict: **PROVEN end-to-end.** Real funded ERC-7710 redemptions through the 1Shot
mainnet relayer work: in-bundle 7702 upgrade, chain-2 and chain-3 bare-EOA redelegation trees
(the sub-card cascade primitive), and the LogicalOrWrapper multi-merchant primitive all land
on-chain with `status:success`. Build-relevant corrections: resolve tx via `relayer_getStatus`,
keep recipient pins on leaves (not the root), and don't put a transfer-shaped period cap on a
swap card's root.

---

## Composite pay+swap OR-group (build-day-1 probe, 2026-06-06)

ESTIMATE-ONLY (no `send`, no submit). File: `probe10-composite.ts`. Chain: Base **mainnet 8453**
(funded `A_user 0x5117...7bba`, already 7702-coded -> NO `authorizationList`). Goal: prove ONE
remit "card" (one root delegation) can serve BOTH capped pay AND a scoped swap by wrapping the
two modes as OR alternatives, so the redeemer picks the branch per redemption.

**Root design under test:** `caveats = [ NonceEnforcer, TimestampEnforcer, LogicalOrWrapper(groupA | groupB) ]`
- group 0 = PAY = `[ ERC20PeriodTransferEnforcer (USDC, $50/week) ]`  (transfer-shaped, 1 caveat)
- group 1 = SWAP = `[ AllowedTargetsEnforcer([USDC, SwapRouter02]), AllowedMethodsEnforcer([transfer, approve, exactInputSingle]) ]`  (2 caveats)

Leaf scope switches with the mode: PAY leaf = `Erc20TransferAmount`; SWAP leaf = `FunctionCall`
(same targets/methods) so the leaf itself doesn't reject swap calls. Per-redemption wrapper
args = `{ groupIndex, caveatArgs[] }`, `caveatArgs.length == group size` (group0 -> 1, group1 -> 2).
Enforcer addrs (SAK env, 8453): AllowedTargets `0x7F20f61b...4EeB`, AllowedMethods `0x2c21fD0C...42B5`,
ERC20PeriodTransfer `0x474e3Ae7...39aB`, LogicalOrWrapper `0xE1302607...B46c` (manual). Results
DETERMINISTIC across two back-to-back runs (no flakiness, no quote expiry, all `http=200`).

| Row | Select | Executions (in order) | Result (verbatim) | Verdict |
|---|---|---|---|---|
| 1 PAY-viaA | group 0 | `[work transfer->MERCHANT, fee transfer->feeCollector]` | `success:true`, `requiredPaymentAmount:"10000"` | **PROVEN** — composite root serves capped pay; both legs transfer-shaped, period group accepts both |
| 2 SWAP-viaB | group 1 | `[approve(router,0.05), exactInputSingle(USDC->WETH 0.05, recipient=A_user), fee transfer->feeCollector]` | `success:true`, `requiredPaymentAmount:"12821"` | **PROVEN** — SAME root serves a scoped 3-execution swap; fee leg (USDC.transfer) passes groupB because `transfer` is in allowedMethods + USDC in allowedTargets |
| 3 (isolation) | — | — | NOT RUN (ROW2 succeeded outright; isolation only fires on a ROW2 failure) | n/a |
| 4 NEG | group 0 | `[approve, exactInputSingle, fee]` (swap-shaped, but PAY group selected) | `Gas estimation failed: Error(ERC20PeriodTransferEnforcer:invalid-method)` | **PROVEN** — OR groups actually gate: selecting the transfer-shaped pay group with non-transfer calls is rejected by the period enforcer |

### BOTTOM LINE

**The composite root design WORKS AS-IS. One card serves both pay AND swap.** A single root
delegation `[nonce, timestamp, LogicalOrWrapper(period-cap | targets+methods)]` reaches
`success:true` for a capped-pay redemption (group 0) AND for a 3-execution swap redemption
(group 1), with the negative control confirming the branches genuinely gate by execution shape.
This resolves the Phase-B blocker (a bare transfer-shaped `erc20PeriodTransfer` root rejects swap
legs): wrapping pay and swap as OR alternatives sidesteps it cleanly. No SkIP, no two-reject.

### Build rules discovered / corrections to the candidate design

1. **OR-wrapper args are passed PER REDEMPTION in the on-wire delegation's `caveats[].args`**
   (the LogicalOrWrapper caveat's `args` field), encoded as `createLogicalOrWrapperArgs({groupIndex,
   caveatArgs})`. `caveatArgs.length` MUST equal the selected group's caveat count (group0=1 element,
   group1=2 elements), each element `"0x00"` (delegation-core rejects `"0x"`; the sub-enforcers
   ignore inner args here). Wrong length -> `LogicalOrWrapperEnforcer:invalid-caveat-args-length`.
2. **groupB MUST include `transfer()` in allowedMethods and USDC in allowedTargets**, otherwise the
   mandatory fee leg (USDC.transfer to feeCollector) is rejected by AllowedMethods/AllowedTargets.
   With both included, fee + approve + exactInputSingle all pass in ONE 3-execution swap request.
3. **CORRECTION to the Phase-B SEND #3 "root caveat maps onto the fee leg only" model.** That model
   was specific to a root `AllowedCalldataEnforcer` pin (single-call-type mode, positional). The
   COMPOSITE swap (ROW2) reached `success:true` with the fee leg in slot 2 and the real work
   (approve, exactInputSingle) in slots 0-1 -> a multi-execution swap request is NOT constrained to
   "work in slot 0, fee unchecked later." `AllowedTargets`/`AllowedMethods` are call-type-agnostic
   and evaluate EVERY governed execution, so all three legs are checked and all three pass. The
   "keep recipient pins on a leaf, not the root" guidance still holds for `AllowedCalldata` recipient
   pins; it does NOT generalize to targets/methods scoping, which works fine on the root inside the
   OR-wrapper across multiple executions.
4. **Mode-gate is clean and free** (`onlyDefaultExecutionMode` wrapper beforeHook never tripped;
   2 and 3 executions both estimated fine). The redeemer selects exactly one branch per request via
   `groupIndex`; you cannot mix pay-leg + swap-leg under different groups in one redemption (one
   group governs the whole request), which is the correct/expected semantics for a "this redemption
   is a pay" vs "this redemption is a swap" card.
5. **Security note carried from probe 4f:** the redeemer picks the group, so BOTH groups must be
   independently safe (group 0's period cap and group 1's targets+methods scope each stand alone).
6. Estimate-only caveat: `success:true` proves the request passes all relayer validation + on-chain
   simulation (gas estimated, `requiredPaymentAmount` returned). Not yet a funded `send` for the
   swap branch; the period-pay branch shape is already Phase-B-proven on-chain. A funded swap `send`
   is the only remaining confirmation and is out of scope for this estimate-only probe.
