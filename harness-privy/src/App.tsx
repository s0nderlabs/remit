import { useMemo, useState } from "react";
import {
  usePrivy,
  useLogin,
  useWallets,
  toViemAccount,
  useSign7702Authorization,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import {
  createPublicClient,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { base } from "viem/chains";
import {
  getSmartAccountsEnvironment,
  toMetaMaskSmartAccount,
  Implementation,
  type Delegation,
} from "@metamask/smart-accounts-kit";
import {
  toDelegationStruct,
  SIGNABLE_DELEGATION_TYPED_DATA,
} from "@metamask/smart-accounts-kit/utils";
import { ROOT_AUTHORITY } from "@metamask/delegation-core";
import {
  BASE_RPC,
  CHAIN_ID,
  DELEGATION_MANAGER,
  THROWAWAY_DELEGATE,
  AUTH_NONCE_DEFAULT,
  DELEGATION_DOMAIN_NAME,
  DELEGATION_DOMAIN_VERSION,
} from "./config";

// ---------------------------------------------------------------------------
// Result log: every step appends a structured entry, exportable as JSON.
// ---------------------------------------------------------------------------
type LogEntry = {
  ts: string;
  step: string;
  status: "INFO" | "PASS" | "FAIL" | "ERROR";
  detail: Record<string, unknown>;
};

const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

// Pretty-print bigints as decimal strings for JSON export / display.
function jsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

export function App() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();

  const [log, setLog] = useState<LogEntry[]>([]);

  function append(step: string, status: LogEntry["status"], detail: Record<string, unknown>) {
    setLog((prev) => [
      ...prev,
      { ts: new Date().toISOString(), step, status, detail },
    ]);
  }

  // The Privy embedded wallet (walletClientType 'privy' or 'privy-v2').
  const embeddedWallet: ConnectedWallet | undefined = useMemo(
    () =>
      wallets.find(
        (w) =>
          w.walletClientType === "privy" || w.walletClientType === "privy-v2",
      ),
    [wallets],
  );
  const embeddedAddress = embeddedWallet?.address as Address | undefined;

  // Stateless7702 implementation address from the kit env for chain 8453.
  const env = useMemo(() => getSmartAccountsEnvironment(CHAIN_ID), []);
  const implAddress = env.implementations
    .EIP7702StatelessDeleGatorImpl as Address;

  // -------------------------------------------------------------------------
  // STEP 1 — LOGIN (handled by useLogin().login(); status shown reactively)
  // -------------------------------------------------------------------------
  function step1Login() {
    if (authenticated) {
      append("1-login", "INFO", {
        note: "already authenticated",
        userId: user?.id,
        embeddedAddress: embeddedAddress ?? "(wallet not ready yet)",
      });
      return;
    }
    login();
    append("1-login", "INFO", { note: "login modal opened" });
  }

  // -------------------------------------------------------------------------
  // STEP 2 — SIGN EIP-7702 AUTHORIZATION + recover signer locally
  // -------------------------------------------------------------------------
  async function step2Sign7702() {
    try {
      if (!embeddedWallet || !embeddedAddress) {
        append("2-7702", "ERROR", { error: "embedded wallet not ready" });
        return;
      }

      // Read the live account nonce from Base mainnet; fresh wallet should be 0.
      let liveNonce = AUTH_NONCE_DEFAULT;
      try {
        liveNonce = await publicClient.getTransactionCount({
          address: embeddedAddress,
        });
      } catch (e) {
        append("2-7702", "INFO", {
          note: "could not fetch live nonce, falling back to default 0",
          rpcError: String(e),
        });
      }

      // Sign the authorization with the embedded wallet (silent: showWalletUIs=false).
      const auth = await signAuthorization(
        {
          contractAddress: implAddress,
          chainId: CHAIN_ID,
          nonce: liveNonce,
        },
        { address: embeddedAddress },
      );

      // Local verification: recover the authority address from r/s/yParity.
      const recovered = await recoverAuthorizationAddress({
        authorization: {
          address: implAddress,
          chainId: CHAIN_ID,
          nonce: liveNonce,
          r: auth.r,
          s: auth.s,
          yParity: auth.yParity,
        },
      });
      const pass = isAddressEqual(recovered, embeddedAddress);

      append("2-7702", pass ? "PASS" : "FAIL", {
        assertion: "recoverAuthorizationAddress(sig) == embedded wallet address",
        defaultNonce: AUTH_NONCE_DEFAULT,
        liveNonce,
        contractAddress: implAddress,
        chainId: CHAIN_ID,
        returned: {
          r: auth.r,
          s: auth.s,
          yParity: auth.yParity,
          v: (auth as { v?: bigint }).v,
          address: (auth as { address?: Address }).address,
          chainId: auth.chainId,
          nonce: auth.nonce,
        },
        recovered,
        embeddedAddress,
      });
    } catch (e) {
      append("2-7702", "ERROR", { error: String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // STEP 3 — SIGN ERC-7710 ROOT DELEGATION (EIP-712) + recover signer locally
  // -------------------------------------------------------------------------
  async function step3SignDelegation() {
    try {
      if (!embeddedWallet || !embeddedAddress) {
        append("3-delegation", "ERROR", { error: "embedded wallet not ready" });
        return;
      }

      // Build the ROOT delegation struct directly (createDelegation demands a
      // scope/parent; the root has authority = ROOT_AUTHORITY and no parent).
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const salt = ("0x" +
        [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;

      const unsigned: Omit<Delegation, "signature"> = {
        delegator: embeddedAddress,
        delegate: THROWAWAY_DELEGATE,
        authority: ROOT_AUTHORITY as Hex,
        caveats: [], // signature plumbing only; caveats validated elsewhere
        salt,
      };

      // Turn the Privy embedded wallet into a viem LocalAccount (toViemAccount is ASYNC).
      const account = await toViemAccount({ wallet: embeddedWallet });
      append("3-debug", "INFO", {
        accountAddress: account.address,
        embeddedAddress,
        wallets: wallets.map((w) => ({
          address: w.address,
          type: w.walletClientType,
        })),
      });

      // FINDING (Jun 5 2026): Privy's iframe RPC JSON-serializes typed data, so
      // BigInt fields (the kit's toDelegationStruct turns salt into a uint256
      // bigint) throw "Do not know how to serialize a BigInt" inside
      // signTypedData. EIP-712 v4 accepts decimal strings for uints, producing
      // the IDENTICAL digest, so deep-convert bigints to strings before they
      // cross the RPC boundary. The real remit dashboard needs this same shim.
      const debigint = (v: unknown): unknown =>
        typeof v === "bigint"
          ? v.toString()
          : Array.isArray(v)
            ? v.map(debigint)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [k, debigint(x)]),
                )
              : v;
      // FINDING #2 (Jun 6 2026): toViemAccount().signTypedData in
      // @privy-io/react-auth 3.29.2 signs with a RANDOM EPHEMERAL KEY (different
      // address every run; signMessage from the same account is fine). Verified
      // by recovery variants E (signMessage -> embedded addr) vs A/B/C
      // (signTypedData -> random addr) vs F (raw eth_signTypedData_v4 ->
      // embedded addr). Workaround: implement signTypedData over the wallet's
      // EIP-1193 provider. The real remit dashboard MUST use this same shim.
      const domainTypeFor = (d: Record<string, unknown>) =>
        (
          [
            ["name", "string"],
            ["version", "string"],
            ["chainId", "uint256"],
            ["verifyingContract", "address"],
            ["salt", "bytes32"],
          ] as const
        )
          .filter(([k]) => d[k] !== undefined)
          .map(([name, type]) => ({ name, type }));
      const rpcSafeAccount = {
        ...account,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signTypedData: async (params: any) => {
          const provider = await embeddedWallet.getEthereumProvider();
          const types = params.types.EIP712Domain
            ? params.types
            : { EIP712Domain: domainTypeFor(params.domain ?? {}), ...params.types };
          const v4 = JSON.stringify({
            domain: debigint(params.domain ?? {}),
            types,
            primaryType: params.primaryType,
            message: debigint(params.message),
          });
          return (await provider.request({
            method: "eth_signTypedData_v4",
            params: [account.address, v4],
          })) as Hex;
        },
      } as typeof account;

      // Build a Stateless7702 smart account at the embedded address, signer = account.
      // NOTE (viem version drift): Privy bundles viem 2.52.0 while the kit + this
      // app use viem 2.31.4. The account/client objects are runtime-identical real
      // viem objects, but TS sees "two different types with the same name", so we
      // cast the params at this single boundary. See README "discrepancies".
      const smartAccount = await toMetaMaskSmartAccount({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: publicClient as any,
        implementation: Implementation.Stateless7702,
        address: embeddedAddress,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signer: { account: rpcSafeAccount as any },
      });

      // Sign the delegation via the smart account's signDelegation method.
      // Returns the EIP-712 signature (Hex) only.
      const signature = await smartAccount.signDelegation({
        delegation: unsigned,
        chainId: CHAIN_ID,
      });

      // Local verification: rebuild the EXACT typed data the kit signs
      // (toDelegationStruct -> salt becomes a uint256/bigint) and recover.
      // SIGNABLE_DELEGATION_TYPED_DATA is the kit's own EIP-712 type set, so the
      // recovered digest exactly matches what signDelegation hashed. The params
      // object is cast as a whole because the kit's readonly TypedData arrays
      // don't structurally line up with viem's mutable generic.
      const delegationStruct = toDelegationStruct({ ...unsigned, signature: "0x" });
      const domain = {
        name: DELEGATION_DOMAIN_NAME,
        version: DELEGATION_DOMAIN_VERSION,
        chainId: CHAIN_ID,
        verifyingContract: DELEGATION_MANAGER,
      };
      const { recoverTypedDataAddress, recoverMessageAddress, hashTypedData } =
        await import("viem");
      // Multi-variant recovery: figure out WHICH digest the Privy iframe signed.
      const variants: Record<string, unknown> = {};
      const tryRecover = async (label: string, fn: () => Promise<string>) => {
        try {
          variants[label] = await fn();
        } catch (err) {
          variants[label] = `recover error: ${String(err).slice(0, 120)}`;
        }
      };
      const baseParams = {
        types: SIGNABLE_DELEGATION_TYPED_DATA,
        primaryType: "Delegation",
        signature,
      };
      await tryRecover("A_full_domain_bigint_salt", () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recoverTypedDataAddress({ ...baseParams, domain, message: delegationStruct } as any));
      await tryRecover("B_full_domain_string_salt", () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recoverTypedDataAddress({ ...baseParams, domain, message: debigint(delegationStruct) } as any));
      await tryRecover("C_kit_env_verifying_contract", async () => {
        const env = getSmartAccountsEnvironment(CHAIN_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return recoverTypedDataAddress({ ...baseParams, domain: { ...domain, verifyingContract: env.DelegationManager }, message: delegationStruct } as any);
      });
      await tryRecover("D_personal_sign_over_digest", () =>
        recoverMessageAddress({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          message: { raw: hashTypedData({ ...baseParams, domain, message: delegationStruct } as any) },
          signature,
        }));
      // E: does plain signMessage from the same account also mis-sign?
      await tryRecover("E_signMessage_path", async () => {
        const sigE = await account.signMessage({ message: "remit-probe" });
        return recoverMessageAddress({ message: "remit-probe", signature: sigE });
      });
      // F: raw provider eth_signTypedData_v4 (Privy's canonical documented path).
      await tryRecover("F_raw_provider_v4", async () => {
        const provider = await embeddedWallet.getEthereumProvider();
        const v4 = JSON.stringify({
          domain,
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ...SIGNABLE_DELEGATION_TYPED_DATA,
          },
          primaryType: "Delegation",
          message: debigint(delegationStruct),
        });
        const sigF = (await provider.request({
          method: "eth_signTypedData_v4",
          params: [embeddedAddress, v4],
        })) as Hex;
        return recoverTypedDataAddress({
          ...baseParams,
          domain,
          message: delegationStruct,
          signature: sigF,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      });
      const verified = isAddressEqual(
        (variants["A_full_domain_bigint_salt"] as Address) ?? "0x0000000000000000000000000000000000000000",
        embeddedAddress,
      );

      append("3-delegation", verified ? "PASS" : "FAIL", {
        assertion:
          "verifyTypedData(DelegationManager domain, signed delegation) == embedded address",
        domain: {
          name: DELEGATION_DOMAIN_NAME,
          version: DELEGATION_DOMAIN_VERSION,
          chainId: CHAIN_ID,
          verifyingContract: DELEGATION_MANAGER,
        },
        delegation: { ...unsigned },
        signature,
        embeddedAddress,
        recoveryVariants: variants,
        verified,
      });
    } catch (e) {
      append("3-delegation", "ERROR", { error: String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4 — EXPORT the full result log as JSON (one click)
  // -------------------------------------------------------------------------
  function step4Export() {
    const payload = {
      harness: "remit privy signing validation",
      generatedAt: new Date().toISOString(),
      chainId: CHAIN_ID,
      embeddedAddress: embeddedAddress ?? null,
      userId: user?.id ?? null,
      implAddress,
      delegationManager: DELEGATION_MANAGER,
      results: log,
    };
    const blob = new Blob([JSON.stringify(payload, jsonReplacer, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `privy-harness-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    append("4-export", "INFO", { note: "downloaded results JSON" });
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  const box: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    maxWidth: 920,
    margin: "32px auto",
    padding: "0 16px",
    lineHeight: 1.5,
  };
  const btn: React.CSSProperties = {
    padding: "8px 14px",
    margin: "4px 8px 4px 0",
    cursor: "pointer",
    fontFamily: "inherit",
  };

  return (
    <div style={box}>
      <h2>remit — Privy signing validation harness</h2>
      <p style={{ fontSize: 13, color: "#555" }}>
        Validates: (2) EIP-7702 authorization via{" "}
        <code>useSign7702Authorization</code> and (3) EIP-712 ERC-7710 delegation
        via SAK <code>signDelegation</code> with an embedded-wallet signer. Both
        steps recover the signer locally and assert it equals the embedded wallet
        address. Chain: Base mainnet (8453).
      </p>

      <div style={{ margin: "12px 0", fontSize: 13 }}>
        <div>ready: {String(ready)}</div>
        <div>authenticated: {String(authenticated)}</div>
        <div>user id: {user?.id ?? "—"}</div>
        <div>embedded wallet: {embeddedAddress ?? "—"}</div>
        <div>Stateless7702 impl: {implAddress}</div>
      </div>

      <div>
        <button style={btn} onClick={step1Login} disabled={!ready}>
          1 · Login
        </button>
        <button style={btn} onClick={step2Sign7702} disabled={!embeddedAddress}>
          2 · Sign 7702 auth
        </button>
        <button style={btn} onClick={step3SignDelegation} disabled={!embeddedAddress}>
          3 · Sign delegation
        </button>
        <button style={btn} onClick={step4Export} disabled={log.length === 0}>
          4 · Export JSON
        </button>
        {authenticated && (
          <button style={btn} onClick={() => logout()}>
            logout
          </button>
        )}
      </div>

      <h3>Log</h3>
      <pre
        style={{
          background: "#0d1117",
          color: "#c9d1d9",
          padding: 12,
          borderRadius: 6,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {log.length === 0
          ? "(no results yet — click the steps in order)"
          : log
              .map(
                (e) =>
                  `[${e.ts}] ${e.step} :: ${e.status}\n${JSON.stringify(
                    e.detail,
                    jsonReplacer,
                    2,
                  )}`,
              )
              .join("\n\n")}
      </pre>
    </div>
  );
}
