// K_agent custody: per-card delegate keypairs, AES-256-GCM envelope-encrypted at rest.
// Master key lives OUTSIDE the DB (env REMIT_MASTER_KEY, 32-byte hex; KMS post-hackathon).
// Plaintext keys exist only in memory inside withAgentAccount's scope; never logged,
// never returned through any API/tool surface.

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { EngineError } from "./errors";

const IV_BYTES = 12;

let cachedKey: CryptoKey | null = null;
let cachedKeyHex: string | null = null;

async function masterKey(): Promise<CryptoKey> {
  const raw = process.env.REMIT_MASTER_KEY;
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    throw new EngineError(
      "custody",
      "REMIT_MASTER_KEY must be set to 32-byte hex (generate: openssl rand -hex 32)",
    );
  }
  if (cachedKey && cachedKeyHex === raw) return cachedKey;
  const bytes = hexToBytes(raw.replace(/^0x/, ""));
  cachedKey = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedKeyHex = raw;
  return cachedKey;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encrypt a UTF-8 secret -> single blob: iv(12) || ciphertext+tag. */
export async function encryptSecret(plaintext: string): Promise<Uint8Array> {
  const key = await masterKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const blob = new Uint8Array(IV_BYTES + ct.length);
  blob.set(iv, 0);
  blob.set(ct, IV_BYTES);
  return blob;
}

export async function decryptSecret(blob: Uint8Array): Promise<string> {
  if (blob.length <= IV_BYTES) throw new EngineError("custody", "ciphertext blob too short");
  const key = await masterKey();
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch (e) {
    throw new EngineError("custody", "decrypt failed (wrong master key or corrupted blob)", e);
  }
}

/** Mint a fresh K_agent. Returns the public address + the encrypted private key blob. */
export async function generateAgentKey(): Promise<{ address: Address; encryptedPk: Uint8Array }> {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  const encryptedPk = await encryptSecret(pk);
  return { address, encryptedPk };
}

/**
 * Run `fn` with the decrypted agent account. The plaintext key's lifetime is the
 * duration of the call; do not capture it outside.
 */
export async function withAgentAccount<T>(
  encryptedPk: Uint8Array,
  fn: (account: PrivateKeyAccount, privateKey: Hex) => Promise<T>,
): Promise<T> {
  const pk = (await decryptSecret(encryptedPk)) as Hex;
  const account = privateKeyToAccount(pk);
  return fn(account, pk);
}

// ---------------------------------------------------------------------------
// Card bearer secrets (the URL credential). 256-bit, base64url; only the
// sha-256 hex digest is ever stored.
// ---------------------------------------------------------------------------

export function generateCardSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function hashCardSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}
