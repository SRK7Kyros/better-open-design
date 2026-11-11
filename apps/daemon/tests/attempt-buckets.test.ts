import { describe, expect, it } from 'vitest';

import { pruneAttemptBuckets, type AttemptBucket } from '../src/http/attempt-buckets.js';

function bucketsOf(entries: Array<[string, AttemptBucket]>): Map<string, AttemptBucket> {
  return new Map(entries);
}

describe('pruneAttemptBuckets', () => {
  it('drops every bucket whose window has passed and keeps the live ones', () => {
    const buckets = bucketsOf([
      ['a', { count: 10, resetAt: 999 }],
      ['b', { count: 1, resetAt: 1_001 }],
      ['c', { count: 1, resetAt: 5_000 }],
    ]);

    pruneAttemptBuckets(buckets, 1_000, 100);

    expect([...buckets.keys()]).toEqual(['b', 'c']);
  });

  it('keeps an unexpired table under the cap intact', () => {
    const buckets = bucketsOf([
      ['a', { count: 1, resetAt: 2_000 }],
      ['b', { count: 1, resetAt: 3_000 }],
    ]);

    pruneAttemptBuckets(buckets, 1_000, 2);

    expect(buckets.size).toBe(2);
  });

  it('trims to the cap by evicting the soonest-expiring buckets', () => {
    // A burst of distinct clients can exceed the cap between sweeps; eviction
    // must be the entries whose lockout is about to end anyway, so nobody is
    // held out longer than the window they already served.
    const buckets = bucketsOf(
      Array.from({ length: 10 }, (_, index) => [
        `client-${index}`,
        { count: 10, resetAt: 2_000 + index },
      ]) as Array<[string, AttemptBucket]>,
    );

    pruneAttemptBuckets(buckets, 1_000, 3);

    expect(buckets.size).toBe(3);
    expect([...buckets.keys()]).toEqual(['client-7', 'client-8', 'client-9']);
  });

  it('frees the whole table once every window has passed', () => {
    const buckets = bucketsOf(
      Array.from({ length: 500 }, (_, index) => [`c${index}`, { count: 3, resetAt: 10 }]),
    );

    pruneAttemptBuckets(buckets, 11, 10_000);

    expect(buckets.size).toBe(0);
  });
});
