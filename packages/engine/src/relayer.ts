// 1Shot Public Relayer JSON-RPC client. Every wire fact here is live-verified
// (probes/RESULTS.md): param shapes DIFFER per method (getCapabilities = flat array,
// getFeeData/getStatus = bare object), send returns a REQUEST ID (not a tx hash),
// status resolves via getStatus({chainId, id}) -> receipt.transactionHash,
// estimate failures come back as result.success:false + error STRING.

import type { Address, Hex } from "viem";
import { CHAINS, CHAIN_ID, type ChainId } from "./chains";
import { EngineError } from "./errors";
import type { Wire7702Auth, WireDelegation, WireExecution } from "./types";

export type RelayerTransaction = {
  permissionContext: WireDelegation[]; // LEAF-FIRST; [0].delegate MUST == targetAddress
  executions: WireExecution[];
};

export type EstimateResult = {
  success: boolean;
  /** atoms string, e.g. "10000" */
  requiredPaymentAmount: string | null;
  /** signed quote blob; pass back to send VERBATIM; single-use, expires ~45s */
  context: string | null;
  error: string | null;
  raw: unknown;
};

export type FeeData = {
  minFee: string; // dollar-decimal string ("0.01")
  rate: number;
  gasPrice: string; // DECIMAL wei string
  expiry: number;
  feeCollector: Address;
  targetAddress: Address;
  context: string;
};

export type Capabilities = {
  targetAddress: Address;
  feeCollector: Address;
  tokens: Array<{ address: Address; decimals: number; symbol?: string }>;
};

export type RelayerStatus = {
  /** 110 = submitted, 200 = confirmed/included, 500 = failure/reverted */
  status: number | null;
  txHash: Hex | null;
  raw: unknown;
};

let rpcId = 1;

export class Relayer {
  readonly chainId: ChainId;
  private caps: Capabilities | null = null;

  constructor(chainId: ChainId = CHAIN_ID) {
    this.chainId = chainId;
  }

  private async call(method: string, params: unknown): Promise<{ result: unknown; error: unknown }> {
    const url = CHAINS[this.chainId].relayer;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      });
    } catch (e) {
      throw new EngineError("relayer", `${method}: network error`, e);
    }
    const text = await res.text();
    let json: { result?: unknown; error?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      throw new EngineError("relayer", `${method}: non-JSON response (http ${res.status}): ${text.slice(0, 200)}`);
    }
    return { result: json.result, error: json.error };
  }

  /** Cached: targetAddress/feeCollector/token list. Params = FLAT array of decimal chainId strings. */
  async getCapabilities(): Promise<Capabilities> {
    if (this.caps) return this.caps;
    const { result, error } = await this.call("relayer_getCapabilities", [String(this.chainId)]);
    if (error || !result) throw new EngineError("relayer", `getCapabilities failed: ${JSON.stringify(error)}`);
    const entry = (result as Record<string, { targetAddress: Address; feeCollector: Address; tokens: Capabilities["tokens"] }>)[
      String(this.chainId)
    ];
    if (!entry?.targetAddress) throw new EngineError("relayer", `getCapabilities: no entry for chain ${this.chainId}`);
    this.caps = { targetAddress: entry.targetAddress, feeCollector: entry.feeCollector, tokens: entry.tokens ?? [] };
    return this.caps;
  }

  /** Params = bare object {chainId, token}. minFee is a DOLLAR-DECIMAL string. */
  async getFeeData(token: Address): Promise<FeeData> {
    const { result, error } = await this.call("relayer_getFeeData", { chainId: String(this.chainId), token });
    if (error || !result) throw new EngineError("relayer", `getFeeData failed: ${JSON.stringify(error)}`);
    const r = result as Record<string, unknown>;
    return {
      minFee: r.minFee as string,
      rate: r.rate as number,
      gasPrice: r.gasPrice as string,
      expiry: r.expiry as number,
      feeCollector: r.feeCollector as Address,
      targetAddress: r.targetAddress as Address,
      context: r.context as string,
    };
  }

  /** authorizationList: EXACTLY ONE entry when present (relayer hard guard); omit once delegator has code. */
  async estimate(transactions: RelayerTransaction[], authorizationList?: Wire7702Auth[]): Promise<EstimateResult> {
    const params: Record<string, unknown> = { chainId: String(this.chainId), transactions };
    if (authorizationList?.length) params.authorizationList = authorizationList;
    const { result, error } = await this.call("relayer_estimate7710Transaction", params);
    const r = (result ?? {}) as Record<string, unknown>;
    const errStr =
      typeof r.error === "string"
        ? r.error
        : error
          ? typeof (error as { message?: string }).message === "string"
            ? (error as { message: string }).message
            : JSON.stringify(error)
          : null;
    return {
      success: r.success === true,
      requiredPaymentAmount: (r.requiredPaymentAmount as string) ?? null,
      context: (r.context as string) ?? null,
      error: errStr,
      raw: result ?? error,
    };
  }

  /** Returns the relayer REQUEST ID (0x-hex). NOT an on-chain tx hash. */
  async send(transactions: RelayerTransaction[], context: string, authorizationList?: Wire7702Auth[]): Promise<string> {
    const params: Record<string, unknown> = { chainId: String(this.chainId), transactions, context };
    if (authorizationList?.length) params.authorizationList = authorizationList;
    const { result, error } = await this.call("relayer_send7710Transaction", params);
    if (error || typeof result !== "string") {
      throw new EngineError("relayer", `send rejected: ${JSON.stringify(error ?? result)}`);
    }
    return result;
  }

  /** Param key MUST be `id` (other keys throw server-side).
   * Live note (Jun 6 2026): the prod endpoint can sit at 110 with hash:null for minutes
   * AFTER on-chain inclusion. Treat this as a HINT; the engine confirms via chain logs. */
  async getStatus(requestId: string): Promise<RelayerStatus> {
    const { result, error } = await this.call("relayer_getStatus", { chainId: String(this.chainId), id: requestId });
    if (error) return { status: null, txHash: null, raw: error };
    const r = (result ?? {}) as Record<string, unknown>;
    const receipt = (r.receipt ?? {}) as Record<string, unknown>;
    return {
      status: typeof r.status === "number" ? r.status : null,
      txHash: ((receipt.transactionHash as Hex) ?? (r.hash as Hex)) || null,
      raw: result,
    };
  }

  /** Poll until confirmed (200) or failed (500). Mined ~1-2 blocks normally. */
  async waitForStatus(
    requestId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<RelayerStatus & { timedOut: boolean }> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;
    let last: RelayerStatus = { status: null, txHash: null, raw: null };
    while (Date.now() < deadline) {
      last = await this.getStatus(requestId);
      if (last.status === 200 || last.status === 500) return { ...last, timedOut: false };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ...last, timedOut: true };
  }
}
