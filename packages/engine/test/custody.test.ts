import { beforeAll, describe, expect, test } from "bun:test";
import { isAddress } from "viem";
import {
  encryptSecret,
  decryptSecret,
  generateAgentKey,
  withAgentAccount,
  generateCardSecret,
  hashCardSecret,
} from "../src/custody";

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "a".repeat(64); // test-only master key
});

describe("envelope encryption", () => {
  test("round trip", async () => {
    const blob = await encryptSecret("0xdeadbeef");
    expect(await decryptSecret(blob)).toBe("0xdeadbeef");
  });

  test("unique IVs: same plaintext -> different ciphertext", async () => {
    const a = await encryptSecret("same");
    const b = await encryptSecret("same");
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });

  test("tamper -> throws", async () => {
    const blob = await encryptSecret("secret");
    blob[blob.length - 1]! ^= 0xff;
    await expect(decryptSecret(blob)).rejects.toThrow();
  });

  test("wrong master key -> throws", async () => {
    const blob = await encryptSecret("secret");
    process.env.REMIT_MASTER_KEY = "b".repeat(64);
    await expect(decryptSecret(blob)).rejects.toThrow();
    process.env.REMIT_MASTER_KEY = "a".repeat(64);
  });
});

describe("agent keys", () => {
  test("generate + use; plaintext never escapes the scope", async () => {
    const { address, encryptedPk } = await generateAgentKey();
    expect(isAddress(address)).toBe(true);
    const recovered = await withAgentAccount(encryptedPk, async (account) => account.address);
    expect(recovered).toBe(address);
  });
});

describe("card secrets", () => {
  test("256-bit base64url, hash stable", () => {
    const s = generateCardSecret();
    expect(s.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(/^[A-Za-z0-9_-]+$/.test(s)).toBe(true);
    expect(hashCardSecret(s)).toBe(hashCardSecret(s));
    expect(hashCardSecret(s)).not.toBe(hashCardSecret(generateCardSecret()));
    expect(hashCardSecret(s)).toMatch(/^[0-9a-f]{64}$/);
  });
});
