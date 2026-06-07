// A keyed async mutex: serializes async sections that share a key, lets different keys
// run concurrently. Used in the server layer to serialize spends per card tree so two
// concurrent redemptions of the same budget can't both pass a read-then-write check
// and overspend the server-side cap (the chain still enforces the true cap; this stops
// the server from APPROVING an over-budget pair). Single-process; no cross-instance
// coordination (the deployment is one Railway process).

export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  /** Run `fn` after any in-flight section for `key` settles; subsequent callers queue
   * behind this one. A throw in `fn` does not break the chain for later callers. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // chain regardless of prior outcome so one failure doesn't wedge the key; wrap fn
    // so it never receives the previous section's value/rejection as an argument
    const next = prev.then(() => fn(), () => fn());
    // keep the tail pointer current; clean up once this is the last waiter
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
