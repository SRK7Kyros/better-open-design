/**
 * Expiring counters keyed by an attacker-influenced string (a client address,
 * a forwarded header). Every caller keeps these in memory, which means the map
 * is the thing that grows when nobody sweeps it: a bucket expires *logically*
 * the moment its window passes, but the entry stays until it is deleted.
 *
 * That is fine for a desktop daemon behind a loopback peer. It is not fine for
 * a public login endpoint: an address-rotating client (IPv6 privacy addresses
 * make this free) adds one permanent entry per attempt, forever, in a process
 * that is meant to run for weeks.
 */
export interface AttemptBucket {
  count: number;
  resetAt: number;
}

/**
 * Drop every expired bucket, then — if the map is still over `max` — drop the
 * entries that expire soonest.
 *
 * Dropping a bucket can only *shorten* a lockout (the client gets a fresh
 * budget), never extend one, so eviction under pressure fails toward
 * availability rather than toward locking somebody out for longer. The cap
 * exists so a burst cannot turn the table into an unbounded allocation; the
 * callers keep it far above the number of clients a real deployment serves.
 */
export function pruneAttemptBuckets(
  buckets: Map<string, AttemptBucket>,
  now: number,
  max: number,
): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size <= max) return;

  const byExpiry = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of byExpiry.slice(0, buckets.size - max)) buckets.delete(key);
}
