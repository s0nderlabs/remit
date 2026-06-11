// In-memory journal of the webhook's authorization decisions. Stripe's sync reply is a
// bare {approved}; in-process callers (the fiat trigger tool, the demo shop) read WHY
// here. Process-local by design (single always-on process), TTL'd + capped.

export type FiatDecision = { approved: boolean; reason: string; cardId: string | null; at: number };

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;

// Map iteration order = insertion order, so the first key is always the oldest entry.
const decisions = new Map<string, FiatDecision>();

export function recordFiatDecision(authId: string, d: Omit<FiatDecision, "at">): void {
  decisions.delete(authId); // re-record moves the entry to the back (freshest)
  decisions.set(authId, { ...d, at: Date.now() });
  while (decisions.size > MAX_ENTRIES) {
    const oldest = decisions.keys().next().value;
    if (oldest === undefined) break;
    decisions.delete(oldest);
  }
}

export function recentFiatDecision(authId: string): FiatDecision | null {
  const d = decisions.get(authId);
  if (!d) return null;
  if (Date.now() - d.at > TTL_MS) {
    decisions.delete(authId);
    return null;
  }
  return d;
}
