// Fiat settlement executor: drives an approved Visa charge row (kind "fiat", status
// "pending") through the spend pipeline as a real delegated USDC transfer to the
// settlement address. The webhook's atomic decide+insert already booked the row
// against the budget; this only executes the on-chain leg.
//
// INVARIANT: a fiat row never becomes "failed": the authorization was already
// approved, so its budget stays held. Terminal problems flip the row to
// "settlement_unconfirmed" AND freeze the card (books/chain divergence is an ops
// condition, not a retry condition).

import { RefusalError, freezeCard, spend } from "@remit/engine";
import { spendDeps, spendKey, type AppDeps } from "../deps";

export type FiatSettler = {
  settle(chargeId: string): Promise<void>;
  sweep(): Promise<{ settled: number; left: number }>;
};

const DEFAULT_BACKOFF_MS = [0, 5_000, 30_000];
/** sweep only picks rows older than this: the webhook's inline kickoff owns fresh rows */
const SWEEP_MIN_AGE_S = 60;

export function makeFiatSettler(
  deps: AppDeps,
  opts?: { backoffMs?: number[]; sleep?: (ms: number) => Promise<void> },
): FiatSettler {
  const backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // freezeCard throws on non-active cards; an already-frozen/revoked card needs nothing
  const freezeIfActive = (cardId: string) => {
    try {
      freezeCard(deps.store, cardId);
    } catch {
      /* not active: nothing to do */
    }
  };

  async function settle(chargeId: string): Promise<void> {
    const row = deps.store.getCharge(chargeId);
    if (!row || row.kind !== "fiat") return;
    if (row.status !== "pending") return; // settled or parked already

    let lastErr: unknown = null;
    for (const waitMs of backoffMs) {
      await sleep(waitMs);
      try {
        // same serialization as every other spend on this card tree; the engine's
        // settle mode re-drives THIS row (no new charge, budget already booked)
        const receipt = await deps.spendMutex.run(spendKey(deps.store, row.card_id), () =>
          spend(spendDeps(deps), row.card_id, { kind: "fiat", mode: "pay", settleChargeId: chargeId }),
        );
        if (receipt.status === "confirmed") {
          console.log(`[settle] charge ${chargeId} settled on-chain (tx ${receipt.tx})`);
          return;
        }
        if (receipt.status === "pending") {
          return; // broadcast (or claimed) but unconfirmed: the reconcile sweep owns the row now
        }
        return; // replayed terminal receipt (confirmed/settlement_unconfirmed): nothing to drive
      } catch (e) {
        if (e instanceof RefusalError && e.code === "card_frozen") {
          return; // row stays pending; an unfreeze lets the sweep resume settlement
        }
        if (e instanceof RefusalError && (e.code === "card_revoked" || e.code === "card_expired")) {
          // the delegation can never settle this row now: park + hold for ops
          deps.store.updateCharge(chargeId, { status: "settlement_unconfirmed" });
          freezeIfActive(row.card_id);
          console.error(`[settle] charge ${chargeId} can never settle (${e.code}); parked settlement_unconfirmed, card ${row.card_id} frozen`);
          return;
        }
        // trust the ROW state, not the error text: the engine parks a row
        // (settlement_unconfirmed) before throwing on an on-chain revert
        const after = deps.store.getCharge(chargeId);
        if (after && after.status !== "pending") {
          freezeIfActive(row.card_id);
          console.error(`[settle] charge ${chargeId} parked ${after.status}; card ${row.card_id} frozen`);
          return;
        }
        lastErr = e; // relayer/network blip with the row still pending: back off and retry
      }
    }
    // retries exhausted: park + freeze, loudly: books say approved, chain has nothing
    deps.store.updateCharge(chargeId, { status: "settlement_unconfirmed" });
    freezeIfActive(row.card_id);
    console.error(
      `[settle] charge ${chargeId} unsettled after ${backoffMs.length} attempts (${lastErr instanceof Error ? lastErr.message : String(lastErr)}); parked settlement_unconfirmed, card ${row.card_id} frozen: needs ops eyes`,
    );
  }

  // a slow sweep (backoff ladders on stuck rows) must not overlap the next tick:
  // overlapping sweeps redundantly walk the same backlog
  let sweeping = false;

  async function sweep(): Promise<{ settled: number; left: number }> {
    if (sweeping) return { settled: 0, left: 0 };
    sweeping = true;
    try {
      const rows = deps.store.unsettledFiatCharges(Math.floor(Date.now() / 1000) - SWEEP_MIN_AGE_S);
      let settled = 0;
      let left = 0;
      for (const row of rows) {
        await settle(row.id);
        const after = deps.store.getCharge(row.id);
        if (after?.status === "confirmed") settled++;
        else if (after?.status === "pending") left++; // frozen card / transient: next sweep
      }
      return { settled, left };
    } finally {
      sweeping = false;
    }
  }

  return { settle, sweep };
}
