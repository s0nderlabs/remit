// Server dependency wiring. ONE process serves MCP + dashboard API + (P3) facilitator
// + seller + webhooks, routed by hostname. Engine objects are singletons here;
// tests build their own AppDeps with fakes.

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Relayer, Store, type DelegationSigner, type SpendDeps } from "@remit/engine";

export type AppDeps = {
  store: Store;
  relayer: Relayer;
  /** dev-mode server-side signer for A_user (local key); P4 adds the pre-signed Privy path */
  userSigner: DelegationSigner | null;
  /** dashboard API bearer token (single-user v1) */
  adminToken: string | null;
  spendOverrides?: Partial<SpendDeps>;
};

export function realDeps(): AppDeps {
  const store = new Store(); // REMIT_DB_PATH or :memory:
  const relayer = new Relayer();
  const pk = process.env.REMIT_DEV_USER_PK as Hex | undefined;
  return {
    store,
    relayer,
    userSigner: pk ? privateKeyToAccount(pk) : null,
    adminToken: process.env.REMIT_ADMIN_TOKEN ?? null,
  };
}

export function spendDeps(deps: AppDeps): SpendDeps {
  return { store: deps.store, relayer: deps.relayer, ...deps.spendOverrides };
}
