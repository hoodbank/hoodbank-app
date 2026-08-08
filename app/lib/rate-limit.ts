// Our own limit, sitting in front of the card provider's.
//
// This is not politeness. Their limit is enforced on the API KEY, and tripping
// it blocks every user of this deployment at once, for minutes rather than
// seconds. One impatient tab must not be able to take cards down for everybody,
// so the budget here is set well under whatever theirs is.
//
// Known ceiling: per-process counters, so a second instance gets its own budget.
// That is the right shape for one server and wrong for a horizontal deploy —
// swap the Map for Redis (Upstash sliding window) when there is more than one.

const hits = new Map<string, number[]>();

/**
 * Returns a ready 429 when over budget, or null when the call may proceed.
 * `key` should identify the caller — the verified wallet, never something the
 * caller controls, or the limit is trivially sidestepped.
 */
export function rateLimit(key: string, limit = 6, windowSec = 60): Response | null {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;

  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  hits.set(key, recent);

  // Opportunistic sweep so idle keys don't accumulate forever. Cheap: it only
  // runs when a bucket is already over, which is rare.
  if (recent.length > limit) {
    for (const [k, v] of hits) if (v.every((t) => t <= cutoff)) hits.delete(k);
    const retry = Math.max(1, Math.ceil((recent[0] - cutoff) / 1000));
    return Response.json(
      { error: `Too many card requests — try again in ${retry}s` },
      { status: 429, headers: { "retry-after": String(retry) } }
    );
  }
  return null;
}
