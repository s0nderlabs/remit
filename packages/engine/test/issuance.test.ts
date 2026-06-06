// Client-signed issuance (the Privy lane). prepareRootCard hands back an UNSIGNED
// root delegation; the browser signs it; finalizeRootCard persists the card. Here a
// local key stands in for the Privy embedded wallet, signed with the SAME SAK path
// the dashboard uses (smartAccount.signDelegation), and we assert the signature
// recovers to the user under the DelegationManager EIP-712 domain.

import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddressEqual, recoverTypedDataAddress } from "viem";
import {
  toDelegationStruct,
  SIGNABLE_DELEGATION_TYPED_DATA,
} from "@metamask/smart-accounts-kit/utils";
import { Store } from "../src/store";
import { prepareRootCard, finalizeRootCard } from "../src/issuance";
import { userSmartAccount, signWithSmartAccount } from "../src/delegations";
import { CHAIN_ID, DELEGATION_MANAGER } from "../src/chains";
import { RefusalError } from "../src/errors";

process.env.REMIT_MASTER_KEY = process.env.REMIT_MASTER_KEY ?? "e".repeat(64);

const user = privateKeyToAccount(generatePrivateKey());
const NOW = 1_750_000_000;
const terms = {
  pay: { period: { amount: "25", seconds: 604800 } },
  expiry: NOW + 30 * 86400,
  subcards: true,
};

describe("client-signed issuance (prepare/finalize)", () => {
  test("prepare returns an UNSIGNED root delegation; nothing stored yet", async () => {
    const store = new Store(":memory:");
    store.upsertUser({ id: "u1", address: user.address });

    const prepared = await prepareRootCard(
      { store, userAddress: user.address, now: () => NOW, revocationNonceOverride: 0n },
      { userId: "u1", name: "privy card", terms },
    );

    expect(store.listCards("u1").length).toBe(0); // prepare persists nothing
    expect(prepared.delegation.signature).toBe("0x");
    expect(prepared.delegation.delegator.toLowerCase()).toBe(user.address.toLowerCase());
    expect(prepared.delegation.delegate.toLowerCase()).toBe(prepared.kAgentAddress.toLowerCase());
    expect(prepared.compiled.rootCaveats.length).toBeGreaterThan(0);
    store.close();
  });

  test("finalize stores the signed card; the signature recovers to the user", async () => {
    const store = new Store(":memory:");
    store.upsertUser({ id: "u1", address: user.address });

    const prepared = await prepareRootCard(
      { store, userAddress: user.address, now: () => NOW, revocationNonceOverride: 0n },
      { userId: "u1", name: "privy card", terms },
    );

    // Sign exactly as the browser does: SAK smartAccount.signDelegation with the
    // embedded wallet as signer (here a local key plays the embedded wallet).
    const smart = await userSmartAccount(user, CHAIN_ID);
    const signed = await signWithSmartAccount(smart, prepared.delegation, CHAIN_ID);
    expect(signed.signature.length).toBeGreaterThan(4);

    // Independent check: recover the signer under the DelegationManager domain.
    const struct = toDelegationStruct({ ...prepared.delegation, signature: "0x" });
    const recovered = await recoverTypedDataAddress({
      domain: { name: "DelegationManager", version: "1", chainId: CHAIN_ID, verifyingContract: DELEGATION_MANAGER },
      types: SIGNABLE_DELEGATION_TYPED_DATA as never,
      primaryType: "Delegation",
      message: struct as never,
      signature: signed.signature,
    });
    expect(isAddressEqual(recovered, user.address)).toBe(true);

    const issued = await finalizeRootCard({ store }, prepared, signed.signature);
    expect(issued.cardId).toBe(prepared.cardId);

    const card = store.getCard(prepared.cardId)!;
    expect(card.delegation.signature).toBe(signed.signature);
    expect(card.delegation.delegator.toLowerCase()).toBe(user.address.toLowerCase());
    expect(card.k_agent_address.toLowerCase()).toBe(prepared.kAgentAddress.toLowerCase());
    expect(card.user_id).toBe("u1");
    expect(card.status).toBe("active");
    expect(card.terms.pay?.period?.amount).toBe("25");
    store.close();
  });

  test("finalize refuses an empty signature", async () => {
    const store = new Store(":memory:");
    store.upsertUser({ id: "u1", address: user.address });
    const prepared = await prepareRootCard(
      { store, userAddress: user.address, now: () => NOW, revocationNonceOverride: 0n },
      { userId: "u1", name: "x", terms },
    );
    await expect(finalizeRootCard({ store }, prepared, "0x")).rejects.toBeInstanceOf(RefusalError);
    expect(store.listCards("u1").length).toBe(0);
    store.close();
  });

  test("finalize refuses a well-formed signature from the WRONG signer", async () => {
    const store = new Store(":memory:");
    store.upsertUser({ id: "u1", address: user.address });
    const prepared = await prepareRootCard(
      { store, userAddress: user.address, now: () => NOW, revocationNonceOverride: 0n },
      { userId: "u1", name: "x", terms },
    );
    // mallory signs the SAME delegation with a different key: valid 65-byte EIP-712
    // signature, recovers to mallory, must NOT finalize a card delegated by `user`
    const mallory = privateKeyToAccount(generatePrivateKey());
    const mallorySmart = await userSmartAccount(mallory, CHAIN_ID);
    const mallorySigned = await signWithSmartAccount(mallorySmart, prepared.delegation, CHAIN_ID);
    expect(mallorySigned.signature.length).toBeGreaterThan(4);
    await expect(finalizeRootCard({ store }, prepared, mallorySigned.signature)).rejects.toBeInstanceOf(RefusalError);
    expect(store.listCards("u1").length).toBe(0);
    store.close();
  });
});
