// In-memory idempotency for POST /api/agent/sessions (issue #144): a retried
// create (the client didn't see the 201) must not spawn a second session +
// worktree. Keyed by a caller-supplied Idempotency-Key, an entry caches the
// in-flight-or-settled create so a retry within the window returns the same
// { id, url } instead of creating again. In-memory + single-user: a key is only
// meaningful for the lifetime of one deck process, which is the retry horizon
// that matters.

interface Entry<T> {
	at: number;
	promise: Promise<T>;
}

const TTL_MS = 10 * 60 * 1000;

// Survive HMR in dev so a retry across a hot reload still dedupes.
const g = globalThis as { __deckIdempotency?: Map<string, Entry<unknown>> };
const cache = (g.__deckIdempotency ??= new Map());

// Run `fn` under an idempotency key (or unconditionally when key is null). A live
// or recently-settled entry for the key is reused (`replay: true`); a rejected one
// is evicted so a later retry can try again. `now` is injectable for tests.
export function runIdempotent<T>(
	key: string | null,
	fn: () => Promise<T>,
	now: number = Date.now()
): { replay: boolean; result: Promise<T> } {
	if (!key) return { replay: false, result: fn() };

	const hit = cache.get(key) as Entry<T> | undefined;
	if (hit && now - hit.at < TTL_MS) return { replay: true, result: hit.promise };

	// Drop entries past their TTL before inserting, so a caller that sends a fresh
	// key every create (a uuid per attempt) can't grow the map without bound.
	for (const [k, e] of cache) {
		if (now - e.at >= TTL_MS) cache.delete(k);
	}

	const promise = fn();
	const entry: Entry<T> = { at: now, promise };
	cache.set(key, entry);
	// Evict on failure so the key isn't poisoned for the whole TTL; only evict our
	// own entry (a newer attempt may have replaced it).
	promise.catch(() => {
		if (cache.get(key) === entry) cache.delete(key);
	});
	return { replay: false, result: promise };
}
